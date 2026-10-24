import { Router, type Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { audit } from "./services/audit.ts";
import {
  applySourceDates,
  prepareSourceDateTargets,
  sourceDateState,
} from "./services/import-source-dates.ts";

const sourceSystemSchema = z.string().trim().min(1).max(100);
const sourceDatesSchema = z
  .object({
    idempotencyKey: z.uuid(),
    sourceSystem: sourceSystemSchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const mcpBodySchemas = { sourceDatesSchema };

type SourceDateInput = z.infer<typeof sourceDatesSchema>;
type RepairResult = Record<string, unknown>;
type Outcome =
  { ok: true; result: RepairResult } | { ok: false; error: HttpError };
type RepairJob = {
  actorId: number;
  input: SourceDateInput;
  startedAt: number;
  updatedAt: number;
  status: "processing" | "completed" | "failed";
  stage: string;
  outcome?: Outcome;
  completion: Promise<Outcome>;
};
const MAX_JOBS = 100;
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;
const RESPONSE_WAIT_MS = 5_000;

function sameInput(left: SourceDateInput, right: SourceDateInput) {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.sourceSystem === right.sourceSystem &&
    left.snapshotHash === right.snapshotHash
  );
}

function publicFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  console.error(
    "Source-date correction failed",
    error instanceof Error ? error.message : "Unknown error",
  );
  return new HttpError(
    500,
    "internal_error",
    "تعذر تأكيد نتيجة تصحيح التواريخ؛ تحقق من حالة الطلب وأعد نفس الطلب عند الحاجة",
  );
}

export function importSourceDateRoutes(pool: Pool): Router {
  const router = Router();
  // Live progress is advisory and process-local. The immutable database receipt
  // remains the authority after completion or a process restart.
  const jobs = new Map<string, RepairJob>();
  const keyFor = (companyId: number, uuid: string) => `${companyId}:${uuid}`;
  const pruneJobs = () => {
    const cutoff = Date.now() - COMPLETED_JOB_TTL_MS;
    for (const [key, job] of jobs) {
      if (job.status !== "processing" && job.updatedAt < cutoff)
        jobs.delete(key);
    }
    if (jobs.size >= MAX_JOBS) {
      for (const [key, job] of jobs) {
        if (job.status !== "processing") {
          jobs.delete(key);
          if (jobs.size < MAX_JOBS) break;
        }
      }
    }
  };
  const readActor = async (req: Request, companyId: number) => {
    // Never wait for the mutation's actor/company row locks just to read status
    // or recognize an already accepted UUID.
    const user = await currentActor(pool, actor(req), false);
    ownerOnly(user);
    if (user.suspended) throw new HttpError(403, "forbidden", "الحساب موقوف");
    await companyAccess(pool, user, companyId);
    return user;
  };
  const progress = (companyId: number, job: RepairJob) => ({
    companyId,
    sourceSystem: job.input.sourceSystem,
    idempotencyKey: job.input.idempotencyKey,
    status: job.status,
    stage: job.stage,
    startedAt: new Date(job.startedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  });
  router.get(
    "/companies/:companyId/transaction-import/source-dates/status/:idempotencyKey",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const uuid = parse(z.uuid(), req.params.idempotencyKey);
      const user = await readActor(req, companyId);
      const receipt = (
        await pool.query(
          "SELECT created_by,result FROM transaction_source_date_repairs WHERE company_id=$1 AND idempotency_key=$2",
          [companyId, uuid],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.created_by !== user.id)
          throw new HttpError(409, "conflict", "مفتاح التصحيح مستخدم لطلب آخر");
        res.json({
          ...receipt.result,
          idempotencyKey: uuid,
          status: "completed",
          replayed: true,
        });
        return;
      }
      const job = jobs.get(keyFor(companyId, uuid));
      if (job) {
        if (job.actorId !== user.id)
          throw new HttpError(409, "conflict", "مفتاح التصحيح مستخدم لطلب آخر");
        // Accepted operations and their retries remain observable if page flags
        // change; they still require the current, unsuspended owner and company.
        res.json({
          ...progress(companyId, job),
          ...(job.outcome?.ok === false
            ? {
                error: {
                  status: job.outcome.error.status,
                  code: job.outcome.error.code,
                  message: job.outcome.error.message,
                },
                retrySameRequest: true,
              }
            : {}),
        });
        return;
      }
      await assertRequestPagesEnabled(pool, req, true);
      res.json({
        companyId,
        idempotencyKey: uuid,
        status: "unknown",
        retrySameRequest: true,
      });
    }),
  );
  router.get(
    "/companies/:companyId/transaction-import/source-dates",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        sourceSystem = parse(sourceSystemSchema, req.query.sourceSystem);
      res.json(
        await transaction(pool, async (db) => {
          const user = await currentActor(db, actor(req));
          ownerOnly(user);
          if (user.suspended)
            throw new HttpError(403, "forbidden", "الحساب موقوف");
          await companyAccess(db, user, companyId, undefined, true);
          await assertRequestPagesEnabled(db, req, true);
          await prepareSourceDateTargets(db, companyId, sourceSystem);
          const state = await sourceDateState(db, companyId, sourceSystem);
          return {
            companyId,
            sourceSystem,
            snapshotHash: state.fingerprint,
            counts: state.counts,
            ledger: state.ledger,
          };
        }),
      );
    }),
  );
  router.post(
    "/companies/:companyId/transaction-import/source-dates",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        input = parse(sourceDatesSchema, req.body);
      const checkedUser = await readActor(req, companyId);
      const encoded = JSON.stringify(input);
      const previous = (
        await pool.query(
          "SELECT *,request_payload=$3::jsonb AS same_payload FROM transaction_source_date_repairs WHERE company_id=$1 AND idempotency_key=$2",
          [companyId, input.idempotencyKey, encoded],
        )
      ).rows[0];
      if (previous) {
        if (previous.created_by !== checkedUser.id || !previous.same_payload)
          throw new HttpError(409, "conflict", "مفتاح التصحيح مستخدم لطلب آخر");
        res.json({ ...previous.result, replayed: true });
        return;
      }
      const jobKey = keyFor(companyId, input.idempotencyKey);
      let job = jobs.get(jobKey);
      if (
        job &&
        (job.actorId !== checkedUser.id || !sameInput(job.input, input))
      )
        throw new HttpError(409, "conflict", "مفتاح التصحيح مستخدم لطلب آخر");
      if (job?.status === "processing") {
        res.status(202).json(progress(companyId, job));
        return;
      }
      if (job?.outcome?.ok) {
        res.json({ ...job.outcome.result, replayed: true });
        return;
      }
      await assertRequestPagesEnabled(pool, req, true);
      // Another request may have registered this UUID while authorization was
      // awaiting the database. Recheck synchronously immediately before insert.
      job = jobs.get(jobKey);
      if (
        job &&
        (job.actorId !== checkedUser.id || !sameInput(job.input, input))
      )
        throw new HttpError(409, "conflict", "مفتاح التصحيح مستخدم لطلب آخر");
      if (job?.status === "processing") {
        res.status(202).json(progress(companyId, job));
        return;
      }
      if (job?.outcome?.ok) {
        res.json({ ...job.outcome.result, replayed: true });
        return;
      }
      pruneJobs();
      // The atomic correction holds its actor row lock. Admit one live job per
      // actor so distinct UUIDs cannot fill the connection pool waiting on that
      // same row and prevent the owner from reading progress.
      if (
        [...jobs.entries()].some(
          ([key, accepted]) =>
            key !== jobKey &&
            accepted.actorId === checkedUser.id &&
            accepted.status === "processing",
        )
      )
        throw new HttpError(
          409,
          "busy",
          "يوجد تصحيح قيد التنفيذ؛ تابع الطلب الأصلي بنفس مفتاحه",
        );
      if (jobs.size >= MAX_JOBS && !jobs.has(jobKey))
        throw new HttpError(
          503,
          "busy",
          "توجد عمليات قيد التنفيذ؛ أعد المحاولة بنفس الطلب لاحقًا",
        );
      const startedAt = Date.now();
      const fresh: RepairJob = {
        actorId: checkedUser.id,
        input,
        startedAt,
        updatedAt: startedAt,
        status: "processing",
        stage: "waiting_for_transaction_locks",
        completion: Promise.resolve({
          ok: false,
          error: new HttpError(500, "internal_error", "لم يبدأ التنفيذ"),
        }),
      };
      jobs.set(jobKey, fresh);
      const report = (stage: string) => {
        fresh.stage = stage;
        fresh.updatedAt = Date.now();
        console.info("Source-date correction progress", {
          companyId,
          idempotencyKey: input.idempotencyKey,
          stage,
          elapsedMs: fresh.updatedAt - fresh.startedAt,
        });
      };
      // Completion is observed here even after an HTTP/MCP caller disconnects.
      // A rejected transaction rolls back dates, projections, audit and receipt.
      fresh.completion = transaction(pool, async (db) => {
        const user = await currentActor(db, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        await companyAccess(db, user, companyId, undefined, true);
        const previous = (
          await db.query(
            "SELECT *,request_payload=$3::jsonb AS same_payload FROM transaction_source_date_repairs WHERE company_id=$1 AND idempotency_key=$2",
            [companyId, input.idempotencyKey, JSON.stringify(input)],
          )
        ).rows[0];
        if (previous) {
          if (previous.created_by !== user.id || !previous.same_payload)
            throw new HttpError(
              409,
              "conflict",
              "مفتاح التصحيح مستخدم لطلب آخر",
            );
          return { ...previous.result, replayed: true };
        }
        await assertRequestPagesEnabled(db, req, true);
        await prepareSourceDateTargets(
          db,
          companyId,
          input.sourceSystem,
          report,
        );
        const before = await sourceDateState(
          db,
          companyId,
          input.sourceSystem,
          report,
        );
        if (before.fingerprint !== input.snapshotHash)
          throw new HttpError(
            409,
            "conflict",
            "تغيرت الحركة منذ المعاينة؛ حدّث معاينة التواريخ",
          );
        const changes = await applySourceDates(db, companyId, report);
        const after = await sourceDateState(
          db,
          companyId,
          input.sourceSystem,
          report,
        );
        if (
          before.unchangedFingerprint !== after.unchangedFingerprint ||
          after.counts.some((r) => r.pending !== 0)
        )
          throw new Error(
            "Source date correction changed protected history or left mismatched dates",
          );
        const result = {
          companyId,
          sourceSystem: input.sourceSystem,
          changed: changes.reduce<Record<string, number>>((out, c) => {
            out[c.table] = (out[c.table] ?? 0) + 1;
            return out;
          }, {}),
          counts: after.counts,
          ledger: after.ledger,
          protectedHistoryUnchanged: true,
        };
        report("audit_and_receipt");
        await audit(
          db,
          user,
          "company.transactions.sourceDates",
          "company",
          companyId,
          { fingerprint: before.fingerprint, counts: before.counts },
          { ...result, changes },
          companyId,
        );
        await db.query(
          "INSERT INTO transaction_source_date_repairs(company_id,idempotency_key,created_by,request_payload,result) VALUES($1,$2,$3,$4,$5)",
          [
            companyId,
            input.idempotencyKey,
            user.id,
            JSON.stringify(input),
            JSON.stringify(result),
          ],
        );
        return { ...result, replayed: false };
      }).then<Outcome, Outcome>(
        (result) => {
          fresh.status = "completed";
          report("completed");
          const outcome: Outcome = { ok: true, result };
          fresh.outcome = outcome;
          return outcome;
        },
        (error: unknown) => {
          fresh.status = "failed";
          report("failed");
          const outcome: Outcome = { ok: false, error: publicFailure(error) };
          fresh.outcome = outcome;
          return outcome;
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        fresh.completion,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), RESPONSE_WAIT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === null) {
        res.status(202).json(progress(companyId, fresh));
      } else if (!outcome.ok) {
        throw outcome.error;
      } else {
        res.json(outcome.result);
      }
    }),
  );
  return router;
}

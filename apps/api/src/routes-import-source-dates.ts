import { Router } from "express";
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

export function importSourceDateRoutes(pool: Pool): Router {
  const router = Router();
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
      res.json(
        await transaction(pool, async (db) => {
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
          await prepareSourceDateTargets(db, companyId, input.sourceSystem);
          const before = await sourceDateState(
            db,
            companyId,
            input.sourceSystem,
          );
          if (before.fingerprint !== input.snapshotHash)
            throw new HttpError(
              409,
              "conflict",
              "تغيرت الحركة منذ المعاينة؛ حدّث معاينة التواريخ",
            );
          const changes = await applySourceDates(db, companyId);
          const after = await sourceDateState(
            db,
            companyId,
            input.sourceSystem,
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
        }),
      );
    }),
  );
  return router;
}

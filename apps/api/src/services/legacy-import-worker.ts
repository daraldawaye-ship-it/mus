import { createHash } from "node:crypto";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { transaction } from "../db.ts";
import { HttpError } from "../errors.ts";
import { companyAccess, currentActor, ownerOnly } from "../policies/access.ts";
import { batchSchema } from "../routes-transaction-import-schemas.ts";
import { audit } from "./audit.ts";
import { moneyString, moneyUnits, quantum } from "./finance.ts";
import { assertRequestPagesEnabled } from "./pages.ts";
import {
  importTransactionBatch,
  type ImportBatch,
  type ImportFailure,
} from "./transaction-import.ts";

const CHUNK_SIZE = 50;
const ROUNDING_POLICY = "unit-price-half-up-v1";
type ImportDocument = ImportBatch["documents"][number];
type Run = {
  company_id: number;
  idempotency_key: string;
  source_system: string;
  created_by: number;
  round_unit_prices: boolean;
  status: "running" | "rebuilding";
};
type StagedRow = {
  source_id: string;
  posting_date: string;
  source_document: unknown;
  request_hash: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** UUID v8: a stable, application-defined SHA-256 identity for the same operation. */
function stableUuid(value: unknown): string {
  const bytes = createHash("sha256").update(JSON.stringify(canonical(value))).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function errorCode(error: unknown): string {
  const code = error instanceof HttpError ? error.code :
    error && typeof error === "object" && "code" in error ? String(error.code) : "worker_error";
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "worker_error";
}
function errorMessage(error: unknown): string {
  const code = errorCode(error);
  return error instanceof HttpError
    ? `[${code}] ${error.message}`.slice(0, 1000)
    : `[${code}] تعذر إكمال خطوة الترحيل؛ تراجعت الخطوة كاملة.`;
}
function request(user: User, companyId: number, resource: string, body: unknown, method: string): Request {
  const path = `/companies/${companyId}/${resource}`;
  return {
    originalUrl: path, path, method, body, auth: { user },
    params: { companyId: String(companyId) },
  } as unknown as Request;
}
async function assertImportPages(
  client: PoolClient, user: User, companyId: number, documents: unknown[],
): Promise<void> {
  await assertRequestPagesEnabled(client,
    request(user, companyId, "transaction-import/batch", { documents }, "POST"), true);
  for (const resource of ["account-ledger", "stock-balances", "stock-movements"])
    await assertRequestPagesEnabled(client, request(user, companyId, resource, {}, "GET"), true);
}

function roundDocument(
  document: ImportDocument, places: number, run: Run, sourceHash: string,
): { document: ImportDocument; rounded: boolean } {
  if (document.type !== "invoice") return { document, rounded: false };
  const step = quantum(places);
  let changed = false;
  const lines = document.payload.lines.map(line => {
    if (line.unitPrice === undefined) return line;
    const units = moneyUnits(line.unitPrice);
    const rounded = (units / step + ((units % step) * 2n >= step ? 1n : 0n)) * step;
    if (rounded === units) return line;
    changed = true;
    return { ...line, unitPrice: moneyString(rounded) };
  });
  if (!changed) return { document, rounded: false };
  const note = `ترحيل تاريخي: تقريب أسعار الوحدات إلى ${places} خانات بطريقة نصف إلى أعلى؛ بيانات المصدر الأصلية محفوظة.`;
  return {
    rounded: true,
    document: {
      ...document,
      // Original sourceRows and movement identities are intentionally unchanged.
      payload: {
        ...document.payload, lines,
        idempotencyKey: stableUuid([
          ROUNDING_POLICY, run.company_id, run.source_system, document.sourceId, sourceHash, places,
        ]),
        description: `${document.payload.description.slice(0, 1000 - note.length - 3)} | ${note}`,
      },
    },
  };
}

async function failDocuments(
  client: PoolClient, run: Run, failures: ImportFailure[],
): Promise<void> {
  if (!failures.length) return;
  const updated = await client.query(
    `UPDATE legacy_import_staging s SET status='failed',error_message=f.message,
       updated_at=clock_timestamp()
     FROM jsonb_to_recordset($3::jsonb) AS f(source_id text,message text)
     WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice'
       AND s.status='pending' AND s.source_id=f.source_id RETURNING s.source_id`,
    [run.company_id, run.source_system, JSON.stringify(failures.map(f => ({
      source_id: f.sourceId, message: `[${f.code}] ${f.message}`.slice(0, 1000),
    })))],
  );
  if (updated.rowCount !== failures.length)
    throw new HttpError(409, "stage_update_mismatch", "تغيرت حالة بعض فواتير التجهيز أثناء المعالجة.");
}

async function importChunk(client: PoolClient, run: Run, user: User): Promise<void> {
  const selected = await client.query<StagedRow>(
    `WITH first AS (
       SELECT posting_date FROM legacy_import_staging
       WHERE company_id=$1 AND source_system=$2 AND source_kind='invoice' AND status='pending'
       ORDER BY posting_date,source_id LIMIT 1
     ) SELECT s.source_id,s.posting_date::text AS posting_date,s.source_document,s.request_hash
       FROM legacy_import_staging s JOIN first f ON f.posting_date=s.posting_date
       WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice' AND s.status='pending'
       ORDER BY s.source_id LIMIT $3 FOR UPDATE OF s`,
    [run.company_id, run.source_system, CHUNK_SIZE],
  );
  const rows = selected.rows;
  if (!rows.length) {
    await client.query(
      `UPDATE legacy_import_runs SET status='rebuilding',phase='rebuilding',
       updated_at=clock_timestamp() WHERE company_id=$1 AND idempotency_key=$2`,
      [run.company_id, run.idempotency_key],
    );
    return;
  }
  await assertImportPages(client, user, run.company_id, rows.map(r => r.source_document));
  const mapped = await client.query<{ source_id: string; request_hash: string }>(
    `SELECT source_id,request_hash FROM transaction_source_imports
     WHERE company_id=$1 AND source_system=$2 AND source_kind='invoice' AND source_id=ANY($3::text[])`,
    [run.company_id, run.source_system, rows.map(r => r.source_id)],
  );
  const existingHashes = new Map(mapped.rows.map(r => [r.source_id, r.request_hash]));
  const currencies = await client.query<{ id: number; decimal_places: number }>(
    "SELECT id,decimal_places FROM company_currencies WHERE company_id=$1",
    [run.company_id],
  );
  const places = new Map(currencies.rows.map(r => [r.id, r.decimal_places]));
  const valid: ImportDocument[] = [];
  const failed: ImportFailure[] = [];
  const rounded = new Set<string>();
  for (const row of rows) {
    // Validate each whole document separately; a fractional quantity is never rounded.
    const parsed = batchSchema.safeParse({
      idempotencyKey: run.idempotency_key, sourceSystem: run.source_system,
      postingDate: row.posting_date, documents: [row.source_document],
    });
    if (!parsed.success) {
      failed.push({
        type: "invoice", sourceId: row.source_id, code: "invalid_staged_document",
        message: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("؛ ").slice(0, 900),
      });
      continue;
    }
    // Intake already normalized all fields except its deliberately permissive
    // quantity string. Keep its original representation for source hash retries.
    const original = row.source_document as ImportDocument;
    if (original.type !== "invoice" || original.sourceId !== row.source_id ||
        fingerprint(original) !== row.request_hash)
      throw new HttpError(409, "staged_source_conflict", "بصمة مستند التجهيز أو هويته لا تطابق المصدر المحفوظ.");
    let prepared: ImportDocument = original;
    let wasRounded = false;
    const mappedHash = existingHashes.get(row.source_id);
    if (run.round_unit_prices && mappedHash !== row.request_hash) {
      const precision = places.get(original.payload.currencyId);
      if (precision === undefined) {
        failed.push({ type: "invoice", sourceId: row.source_id, code: "invalid_reference", message: "عملة الفاتورة غير موجودة في الشركة." });
        continue;
      }
      let result: ReturnType<typeof roundDocument>;
      try {
        result = roundDocument(original, precision, run, row.request_hash);
      } catch(error) {
        failed.push({type:"invoice",sourceId:row.source_id,code:errorCode(error),message:errorMessage(error)});
        continue;
      }
      // Existing provenance must still pass the shared service's exact hash check.
      // Accept a previously rounded identity only when the same policy recreates it.
      if (!mappedHash || mappedHash === fingerprint(result.document)) {
        prepared = result.document;
        wasRounded = result.rounded;
      }
    }
    const normalized = batchSchema.safeParse({
      idempotencyKey: run.idempotency_key, sourceSystem: run.source_system,
      postingDate: row.posting_date, documents: [prepared],
    });
    if (!normalized.success) {
      failed.push({ type: "invoice", sourceId: row.source_id, code: "invalid_staged_document", message: "تعذر التحقق من الفاتورة بعد سياسة تقريب الأسعار." });
      continue;
    }
    valid.push(prepared);
    if (wasRounded) rounded.add(row.source_id);
  }
  const batch: ImportBatch = {
    idempotencyKey: stableUuid([
      "legacy-import-chunk-v1", run.idempotency_key, rows[0]!.posting_date,
      valid.map(document => [document.sourceId, fingerprint(document)]),
    ]),
    sourceSystem: run.source_system, postingDate: rows[0]!.posting_date, documents: valid,
  };
  const result = valid.length
    ? await importTransactionBatch(client, user, run.company_id, batch,
      () => assertImportPages(client, user, run.company_id, valid))
    : { imported: [], existing: [], failed: [] };
  failed.push(...result.failed);
  const completed = [...result.imported, ...result.existing];
  if (completed.length) {
    const updated = await client.query(
      `UPDATE legacy_import_staging SET status='completed',error_message=NULL,updated_at=clock_timestamp()
       WHERE company_id=$1 AND source_system=$2 AND source_kind='invoice' AND status='pending'
         AND source_id=ANY($3::text[]) RETURNING source_id`,
      [run.company_id, run.source_system, completed.map(d => d.sourceId)],
    );
    if (updated.rowCount !== completed.length)
      throw new HttpError(409, "stage_update_mismatch", "تغيرت حالة بعض فواتير التجهيز أثناء المعالجة.");
  }
  await failDocuments(client, run, failed);
  if (completed.length + failed.length !== rows.length)
    throw new HttpError(409, "stage_result_mismatch", "نتيجة الدفعة لا تغطي كل فواتير التجهيز المختارة.");
  await client.query(
    `UPDATE legacy_import_runs SET imported=imported+$3,existing=existing+$4,
       failed_documents=failed_documents+$5,rounded=rounded+$6,last_posting_date=$7::date,
       last_source_id=$8,phase='importing',error_message=NULL,updated_at=clock_timestamp()
     WHERE company_id=$1 AND idempotency_key=$2`,
    [run.company_id, run.idempotency_key, result.imported.length, result.existing.length,
      failed.length, completed.filter(d => rounded.has(d.sourceId)).length,
      rows[0]!.posting_date, rows.at(-1)!.source_id],
  );
}

async function rebuild(client: PoolClient, run: Run, user: User): Promise<void> {
  await assertImportPages(client, user, run.company_id, [
    { type: "invoice", payload: { kind: "sale" } },
    { type: "invoice", payload: { kind: "purchase" } },
  ]);
  await client.query("SELECT finalize_legacy_import_projections($1)", [run.company_id]);
  // Flush deferred checks while the run/context still defers their heavy work.
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  const dirty = await client.query<{ item_id: number }>(
    "SELECT item_id FROM legacy_import_dirty_items WHERE company_id=$1 ORDER BY item_id",
    [run.company_id],
  );
  for (const item of dirty.rows)
    await client.query("SELECT assert_stock_integrity($1,$2)", [run.company_id, item.item_id]);
  await client.query("DELETE FROM legacy_import_dirty_items WHERE company_id=$1", [run.company_id]);
  await client.query(
    `UPDATE legacy_import_runs SET status='completed',phase='completed',error_message=NULL,
       finished_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE company_id=$1 AND idempotency_key=$2`,
    [run.company_id, run.idempotency_key],
  );
  await audit(client, user, "company.transactions.bulk-complete", "company", run.company_id,
    { idempotencyKey: run.idempotency_key, status: "rebuilding" },
    { idempotencyKey: run.idempotency_key, status: "completed", reconciledItems: dirty.rows.length },
    run.company_id);
}

async function step(pool: Pool): Promise<boolean> {
  const candidate = (await pool.query<Run>(
    `SELECT company_id,idempotency_key FROM legacy_import_runs
     WHERE status IN ('running','rebuilding') ORDER BY updated_at,company_id LIMIT 1`,
  )).rows[0];
  if (!candidate) return false;
  return transaction(pool, async client => {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':legacy-import-worker'),$1::integer) AS acquired",
      [candidate.company_id],
    );
    if (!lock.rows[0]?.acquired) return false;
    const initial = (await client.query<Run>(
      `SELECT * FROM legacy_import_runs WHERE company_id=$1 AND idempotency_key=$2
       AND status IN ('running','rebuilding')`,
      [candidate.company_id, candidate.idempotency_key],
    )).rows[0];
    if (!initial) return false;
    await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)", [initial.idempotency_key]);
    await client.query("SAVEPOINT legacy_import_step");
    try {
      // currentActor uses only the supplied ID and reloads the actual user under lock.
      const user = await currentActor(client, { id: initial.created_by } as User);
      ownerOnly(user);
      if (user.suspended) throw new HttpError(403, "forbidden", "الحساب موقوف");
      await companyAccess(client, user, initial.company_id, undefined, true);
      // Match the API's user -> company -> run lock order so pause/resume cannot deadlock.
      const run = (await client.query<Run>(
        `SELECT * FROM legacy_import_runs WHERE company_id=$1 AND idempotency_key=$2
         AND status IN ('running','rebuilding') FOR UPDATE`,
        [initial.company_id, initial.idempotency_key],
      )).rows[0];
      if (!run) {
        await client.query("RELEASE SAVEPOINT legacy_import_step");
        return false;
      }
      if (run.status === "rebuilding") await rebuild(client, run, user);
      else await importChunk(client, run, user);
      await client.query("RELEASE SAVEPOINT legacy_import_step");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT legacy_import_step");
      await client.query("RELEASE SAVEPOINT legacy_import_step");
      // An unfinished failed run deliberately retains company maintenance isolation.
      await client.query(
        `UPDATE legacy_import_runs SET status='failed',error_message=$3,updated_at=clock_timestamp()
         WHERE company_id=$1 AND idempotency_key=$2 AND status IN ('running','rebuilding')`,
        [initial.company_id, initial.idempotency_key, errorMessage(error)],
      );
      console.error("Legacy import step failed", initial.company_id, initial.idempotency_key, errorCode(error));
    }
    return true;
  });
}

/** One bounded, atomic step. Failed runs require an explicit owner resume. */
export async function runLegacyImportStep(pool: Pool): Promise<void> {
  await step(pool);
}

/** Durable running/rebuilding rows resume after restart; no unrequested run is created. */
export function startLegacyImportWorker(pool: Pool): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | null = null;
  const tick = () => {
    if (stopped || current) return;
    let worked = false;
    current = step(pool)
      .then(result => { worked = result; })
      .catch((error: unknown) => console.error("Legacy import worker failed", errorCode(error)))
      .finally(() => {
        current = null;
        if (!stopped) {
          timer = setTimeout(tick, worked ? 250 : 1000);
          timer.unref();
        }
      });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
  };
}

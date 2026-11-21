import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";

function publicHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    // References are stored as evidence, never fetched by this endpoint.
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      /\s/.test(value) || !url.hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|example|invalid)$/.test(url.hostname) ||
      !/^[a-z0-9.-]+\.[a-z][a-z0-9-]{1,62}$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}
const medaweeAgentRef = z.string().max(1200).refine(value => {
  const url = publicHttps(value);
  return url?.hostname === "medawee.com" && !url.search && !url.hash &&
    /^\/medicines\/entity\/agent\/[a-f0-9]{24}(?:\/[^/?#]+)?$/.test(url.pathname);
}, "Expected a public Medawee agent reference");
const evidenceCommon = {
  medaweeAgentUrl: medaweeAgentRef,
  observedAt: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(1).max(1200),
};
const evidenceSchema = z.discriminatedUnion("sourceKind", [
  z.object({
    ...evidenceCommon,
    sourceKind: z.literal("medawee"),
    sourceUrl: z.string().max(1200).refine(value => {
      const url = publicHttps(value);
      return url?.hostname === "medawee.com" && /^\/medicines(?:\/|$)/.test(url.pathname);
    }, "Expected a public Medawee medicine URL"),
  }).strict(),
  z.object({
    ...evidenceCommon,
    sourceKind: z.literal("official_catalog"),
    sourceUrl: z.string().max(1200).refine(value => publicHttps(value) !== null,
      "Expected a public HTTPS catalog URL"),
  }).strict(),
  z.object({
    ...evidenceCommon,
    sourceKind: z.literal("authorized_document"),
    documentId: z.string().trim().min(1).max(160).regex(/^[\p{L}\p{N}_.:#-]+$/u),
    locator: z.string().trim().min(1).max(240),
  }).strict(),
]);

const itemText = z.string().trim().min(1).max(300).nullable().optional();
export const medaweeItemBatchSchema = z.object({
  batchId: z.uuid(),
  rows: z.array(z.object({
    englishName: itemText,
    arabicName: itemText,
    defaultSalePriceOldCurrency: z.string().regex(/^\d{1,14}(?:\.\d{1,4})?$/).nullable().optional(),
    composition: itemText,
    agent: itemText,
    manufacturer: itemText,
    evidence: evidenceSchema,
  }).strict().refine(row => !!(row.englishName || row.arabicName), "An Arabic or English item name is required")).min(1).max(20),
}).strict();

export const medaweeItemListSchema = z.object({
  after: z.string().regex(/^\d{1,19}$/).refine(x => BigInt(x) <= 9223372036854775807n).default("0"),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const projection = `id::text AS id, english_name AS "englishName", arabic_name AS "arabicName",
 default_sale_price_old_currency::text AS "defaultSalePriceOldCurrency", composition, agent, manufacturer,
 completion_status AS "completionStatus", intake_batch_id AS "batchId", source_evidence AS evidence`;

export async function listMedaweeItems(pool: Pool, query: z.infer<typeof medaweeItemListSchema>) {
  const { rows } = await pool.query(
    // Qualify the sort to avoid comparing the projected text alias rather than the bigint ID.
    `SELECT ${projection} FROM medawee_items_staging s WHERE s.id > $1::bigint ORDER BY s.id LIMIT $2`,
    [query.after, query.pageSize + 1],
  );
  const items = rows.slice(0, query.pageSize);
  return { items, nextCursor: rows.length > query.pageSize ? items.at(-1)!.id : null };
}

export async function intakeMedaweeItems(pool: Pool, actorId: number, input: z.infer<typeof medaweeItemBatchSchema>) {
  const payloadHash = createHash("sha256").update(JSON.stringify(input.rows)).digest("hex");
  return transaction(pool, async db => {
    const claim = await db.query(
      `INSERT INTO medawee_item_intake_batches(batch_id,actor_id,payload_hash)
       VALUES ($1,$2,$3) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`,
      [input.batchId, actorId, payloadHash],
    );
    if (!claim.rowCount) {
      const { rows } = await db.query(
        "SELECT actor_id::text,payload_hash,receipt FROM medawee_item_intake_batches WHERE batch_id=$1", [input.batchId],
      );
      const prior = rows[0];
      if (!prior?.receipt || prior.payload_hash !== payloadHash || prior.actor_id !== String(actorId))
        throw new HttpError(409, "medawee_batch_conflict", "معرّف الدفعة مستخدم لطلب مختلف");
      return { ...prior.receipt, replayed: true };
    }
    const items = [];
    for (const row of input.rows) {
      const result = await db.query(
        `INSERT INTO medawee_items_staging (
          english_name,arabic_name,default_sale_price_old_currency,composition,agent,manufacturer,intake_batch_id,source_evidence
        ) VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8::jsonb) RETURNING ${projection}`,
        [row.englishName ?? null, row.arabicName ?? null, row.defaultSalePriceOldCurrency ?? null,
         row.composition ?? null, row.agent ?? null, row.manufacturer ?? null, input.batchId, JSON.stringify(row.evidence)],
      );
      items.push(result.rows[0]);
    }
    const receipt = { batchId: input.batchId, inserted: items.length, items };
    await db.query("UPDATE medawee_item_intake_batches SET receipt=$2::jsonb WHERE batch_id=$1",
      [input.batchId, JSON.stringify(receipt)]);
    return { ...receipt, replayed: false };
  });
}

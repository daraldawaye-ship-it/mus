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
 completion_status AS "completionStatus", linked_market_card_id AS "linkedMarketCardId",
 review_revision AS "reviewRevision", intake_batch_id AS "batchId", source_evidence AS evidence`;

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


const reviewItemId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(x => BigInt(x) <= 9223372036854775807n);
const cardId = z.number().int().min(1).max(2147483647);
const reviewBase = { id: reviewItemId, expectedRevision: z.number().int().min(0).max(2147483646) };
export const medaweeItemReviewBatchSchema = z.object({
  entries: z.array(z.discriminatedUnion("status", [
    z.object({ ...reviewBase, status: z.literal("complete"), marketCardId: cardId }).strict(),
    z.object({ ...reviewBase, status: z.literal("needs_verification"),
      marketCardId: cardId.nullable(), remaining: z.string().trim().min(1).max(500) }).strict(),
  ])).min(1).max(50),
}).strict().refine(({ entries }) => new Set(entries.map(e => e.id)).size === entries.length,
  "Each staging row may occur only once per batch");

export async function reviewMedaweeItems(pool: Pool, actor: { id: number; displayName: string },
    input: z.infer<typeof medaweeItemReviewBatchSchema>) {
  return transaction(pool, async db => {
    const items = [];
    const ordered = [...input.entries].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    for (const entry of ordered) {
      const prior = (await db.query(
        'SELECT id::text AS id, completion_status, linked_market_card_id, review_revision ' +
        'FROM medawee_items_staging WHERE id=$1::bigint FOR UPDATE', [entry.id],
      )).rows[0];
      if (!prior) throw new HttpError(404, "medawee_item_not_found", "سجل ميداوي غير موجود");
      if (prior.review_revision !== entry.expectedRevision)
        throw new HttpError(409, "medawee_item_revision_conflict", "راجع الحالة الحالية قبل إعادة الحفظ");
      if (prior.linked_market_card_id !== null && prior.linked_market_card_id !== entry.marketCardId)
        throw new HttpError(409, "medawee_item_card_conflict", "للسجل رابط سوق محفوظ؛ لا يُستبدل في دفعة المراجعة");
      if (entry.marketCardId !== null) {
        const target = await db.query(
          "SELECT id FROM medicine_market_cards WHERE id=$1 AND kind='medicine' AND status='published' AND NOT archived FOR SHARE",
          [entry.marketCardId],
        );
        if (!target.rowCount)
          throw new HttpError(422, "medawee_market_card_invalid", "يجب اختيار كرت صنف نشط ومنشور في السوق");
      }
      const status = entry.status === "complete" ? "منجز بالكامل" : "تبقى التأكد من: " + entry.remaining;
      if (prior.completion_status === status && prior.linked_market_card_id === entry.marketCardId) {
        const current = await db.query(`SELECT ${projection} FROM medawee_items_staging WHERE id=$1::bigint`, [entry.id]);
        items.push(current.rows[0]);
        continue;
      }
      const updated = await db.query(
        `UPDATE medawee_items_staging SET completion_status=$2, linked_market_card_id=$3,
          review_revision=review_revision+1 WHERE id=$1::bigint RETURNING ${projection}`,
        [entry.id, status, entry.marketCardId],
      );
      await db.query(
        "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)" +
        " VALUES($1,$2,'public',NULL,'medicine-market.medawee-item-review','medicine-market',$3,$4::jsonb,$5::jsonb)",
        [actor.id, actor.displayName, entry.marketCardId, JSON.stringify(prior),
         JSON.stringify({ id: entry.id, completionStatus: status, linkedMarketCardId: entry.marketCardId,
           reviewRevision: updated.rows[0].reviewRevision })],
      );
      items.push(updated.rows[0]);
    }
    return { items };
  });
}

import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  marketKinds,
  marketTypes,
  type MarketCard,
  type MarketComment,
  type MarketContribution,
  type MarketField,
  type MarketKind,
  type MarketPermissions,
} from "../../../packages/contracts/src/medicine-market.ts";
import type { User } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction, type Database } from "./db.ts";
import { currentActor } from "./policies/access.ts";
import { deny, HttpError, missing } from "./errors.ts";

const root = "/medicine-market";
const json = (v: unknown) => JSON.stringify(v ?? null);
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : (v ?? null);
const same = (a: unknown, b: unknown) =>
  json(canonical(a)) === json(canonical(b));
const trusted = (u: User | null) =>
  !!u &&
  (u.owner ||
    u.kind === "admin" ||
    u.kind === "supervisor" ||
    u.editor ||
    u.monitor);
const perms = (u: User | null): MarketPermissions => ({
  canContribute: !!u && !u.suspended,
  canModerate: !!u && !u.suspended && (u.owner || u.kind === "admin"),
  canConfigure: !!u && !u.suspended && (u.owner || u.kind === "admin"),
  canArchive: !!u && !u.suspended && (u.owner || u.kind === "admin"),
  canSeeMinistry: !!u && (u.owner || u.kind === "admin" || u.monitor),
  canSeeAccounting: !!u && (u.owner || u.kind === "admin"),
});
const canField = (field: MarketField, p: MarketPermissions) =>
  field.visibility === "public" ||
  (field.visibility === "ministry" && p.canSeeMinistry) ||
  (field.visibility === "accounting" && p.canSeeAccounting);
const findType = (kind: string) =>
  marketTypes.find((t) => t.key === kind) ?? missing("نوع الكرت غير موجود");
const findField = (kind: string, key: string) =>
  findType(kind).fields.find((f) => f.key === key) ??
  missing("الحقل غير موجود");
const conflict = (
  message = "تغيّرت القيمة منذ فتحها؛ حدّث الكرت قبل المحاولة",
) => new HttpError(409, "conflict", message);
const decimal = z
  .string()
  .trim()
  .overwrite((s) =>
    s
      .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
      .replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
      .replace(/٫/g, "."),
  )
  .regex(
    /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/,
    "أدخل عددًا عشريًا موجبًا أو صفرًا دون فواصل آلاف",
  )
  .transform((s) =>
    s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s,
  );
const positive = decimal.refine(
  (s) => /[1-9]/.test(s),
  "القوة يجب أن تكون موجبة",
);
const text = z.string().trim().max(300);
const url = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "استخدم رابط HTTPS صالحًا");
const ingredient = z
  .object({
    scientificId: z.number().int().positive(),
    strength: positive,
    unit: z.string().trim().min(1).max(30),
    denominator: positive.optional(),
    denominatorUnit: z.string().trim().min(1).max(30).optional(),
  })
  .strict()
  .refine(
    (x) => !!x.denominator === !!x.denominatorUnit,
    "أدخل مقدار التركيز ووحدته معًا",
  );
const contact = z
  .object({
    name: z.string().trim().min(1).max(150),
    role: z.string().trim().max(150).optional(),
    phone: z.string().trim().min(3).max(40),
  })
  .strict();
function normalizeValue(field: MarketField, value: unknown): unknown {
  if (value === null || value === "") {
    if (field.key === "name")
      throw new HttpError(400, "validation", "الاسم مطلوب");
    return null;
  }
  switch (field.type) {
    case "text":
      return parse(
        field.key === "name"
          ? text.min(1)
          : field.key === "currency"
            ? z
                .string()
                .trim()
                .regex(/^[A-Za-z]{3}$/, "رمز العملة من ثلاثة أحرف مثل YER")
                .transform((s) => s.toUpperCase())
            : text,
        value,
      );
    case "textarea":
      return parse(z.string().trim().max(5000), value);
    case "boolean":
      return parse(z.boolean(), value);
    case "decimal":
      return parse(decimal, value);
    case "percent":
      return parse(
        decimal.refine((s) => {
          const [a, b = ""] = s.split(".");
          return BigInt(a!) * 1000000n + BigInt(b.padEnd(6, "0")) <= 100000000n;
        }, "النسبة بين صفر و100"),
        value,
      );
    case "url":
      return parse(url, value);
    case "date":
      return parse(
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine((s) => {
            const d = new Date(s + "T00:00:00Z");
            return (
              Number.isFinite(d.getTime()) &&
              d.toISOString().slice(0, 10) === s &&
              s >= "0001-01-01"
            );
          }, "تاريخ غير صالح"),
        value,
      );
    case "relation":
      return parse(z.number().int().positive().max(2147483647), value);
    case "contacts":
      return parse(z.array(contact).max(30), value);
    case "ingredients":
      return parse(z.array(ingredient).min(1).max(20), value);
    case "accounting":
      return parse(
        z
          .array(
            z
              .object({
                system: z.string().trim().min(1).max(100),
                identifier: z.string().trim().min(1).max(100),
              })
              .strict(),
          )
          .max(8),
        value,
      );
  }
}
async function validateReferences(
  db: Database,
  field: MarketField,
  value: unknown,
) {
  if (value === null) return;
  const refs =
    field.type === "relation"
      ? [{ id: value as number, kind: field.relationKind! }]
      : field.type === "ingredients"
        ? (value as { scientificId: number }[]).map((v) => ({
            id: v.scientificId,
            kind: "scientific-name",
          }))
        : [];
  for (const ref of refs) {
    const row = (
      await db.query(
        "SELECT id FROM medicine_market_cards WHERE id=$1 AND kind=$2 AND status='published' AND NOT archived FOR SHARE",
        [ref.id, ref.kind],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        400,
        "invalid_reference",
        "اختر كرتًا منشورًا وفعالًا من النوع الصحيح",
      );
  }
}
async function enabled(
  db: Database,
  section = "medicine-market",
  lock = false,
) {
  const keys =
    section === "medicine-market"
      ? ["public.medicine-market"]
      : ["public.medicine-market", `public.${section}`];
  const rows = await db.query(
    `SELECT enabled FROM page_settings WHERE company_id IS NULL AND page_key=ANY($1::text[]) ${lock ? "FOR SHARE" : ""}`,
    [keys],
  );
  if (rows.rows.some((r) => !r.enabled)) deny("هذه الصفحة موقوفة حاليًا");
}
async function viewer(
  db: Database,
  req: Request,
  write = false,
): Promise<User | null> {
  const u = req.auth ? await currentActor(db, actor(req), write) : null;
  if (write && (!u || u.suspended)) {
    if (!u) actor(req);
    deny("الحساب موقوف عن المشاركة");
  }
  return u;
}
async function auditMarket(
  db: Database,
  u: User,
  action: string,
  targetId: number | null,
  before: object | null,
  after: object | null,
) {
  await db.query(
    "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES($1,$2,'public',NULL,$3,'medicine-market',$4,$5,$6)",
    [
      u.id,
      u.displayName,
      `medicine-market.${action}`,
      targetId,
      before ? json(before) : null,
      after ? json(after) : null,
    ],
  );
}
function pagination(req: Request) {
  const q = parse(z.string().max(200), req.query.q ?? "");
  const page = parse(
      z.coerce.number().int().positive().max(1000000),
      req.query.page ?? 1,
    ),
    pageSize = parse(
      z.coerce.number().int().positive().max(100),
      req.query.pageSize ?? 20,
    );
  return { q, page, pageSize, offset: (page - 1) * pageSize };
}
function cardData(
  row: QueryResultRow,
  p: MarketPermissions,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row.data as Record<string, unknown>).filter(([k]) => {
      const f = findType(row.kind).fields.find((x) => x.key === k);
      return f && canField(f, p);
    }),
  );
}
function cardOutput(row: QueryResultRow, p: MarketPermissions): MarketCard {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    data: cardData(row, p),
    status: row.status,
    archived: row.archived,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    likes: Number(row.likes ?? 0),
    ratingAverage:
      row.rating_average == null ? null : Number(row.rating_average),
    ratingCount: Number(row.rating_count ?? 0),
    myLiked: row.my_liked ?? false,
    myRating: row.my_rating ?? null,
  };
}
const cardSelect = `SELECT c.*,(SELECT count(*) FROM medicine_market_reactions r WHERE r.card_id=c.id AND r.liked) likes,(SELECT avg(r.rating) FROM medicine_market_reactions r WHERE r.card_id=c.id) rating_average,(SELECT count(r.rating) FROM medicine_market_reactions r WHERE r.card_id=c.id) rating_count,COALESCE((SELECT r.liked FROM medicine_market_reactions r WHERE r.card_id=c.id AND r.user_id=$1),false) my_liked,(SELECT r.rating FROM medicine_market_reactions r WHERE r.card_id=c.id AND r.user_id=$1) my_rating FROM medicine_market_cards c`;
async function getCard(
  db: Database,
  cardId: number,
  u: User | null,
  lock = false,
) {
  const row = (
    await db.query(
      `${cardSelect} WHERE c.id=$2 ${lock ? "FOR UPDATE OF c" : ""}`,
      [u?.id ?? null, cardId],
    )
  ).rows[0];
  if (
    !row ||
    ((row.status !== "published" || row.archived) &&
      !(perms(u).canModerate || u?.id === row.created_by))
  )
    missing();
  return row;
}
function contributionOutput(row: QueryResultRow): MarketContribution {
  return {
    id: row.id,
    cardId: row.card_id,
    cardName: row.card_name,
    kind: row.kind,
    fieldKey: row.field_key,
    fieldLabel: findField(row.kind, row.field_key).label,
    previousValue: row.previous_value,
    value: row.proposed_value,
    source: row.source,
    authorId: row.author_id,
    authorName: row.author_name,
    status: row.status,
    published: row.published,
    awardedPoints: row.awarded_points,
    reviewerId: row.reviewer_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
  };
}
const contributionSelect =
  "SELECT p.*,c.name card_name,c.kind,u.display_name author_name FROM medicine_market_contributions p JOIN medicine_market_cards c ON c.id=p.card_id JOIN users u ON u.id=p.author_id";
function commentOutput(row: QueryResultRow): MarketComment {
  return {
    id: row.id,
    cardId: row.card_id,
    cardName: row.card_name,
    authorId: row.author_id,
    authorName: row.author_name,
    text: row.text,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
const commentSelect =
  "SELECT p.*,c.name card_name,u.display_name author_name FROM medicine_market_comments p JOIN medicine_market_cards c ON c.id=p.card_id JOIN users u ON u.id=p.author_id";
async function contributionById(db: Database, contributionId: number) {
  return (
    (await db.query(contributionSelect + " WHERE p.id=$1", [contributionId]))
      .rows[0] ?? missing()
  );
}
function readableKeys(p: MarketPermissions) {
  return marketTypes
    .flatMap((t) => t.fields.filter((f) => canField(f, p)).map((f) => f.key))
    .filter((x, i, a) => a.indexOf(x) === i);
}
async function points(db: Database, userId: number | null): Promise<string> {
  if (!userId) return "0";
  return (
    await db.query(
      "SELECT COALESCE(sum(points),0)::text points FROM medicine_market_points WHERE user_id=$1",
      [userId],
    )
  ).rows[0].points;
}
async function applyField(
  db: Database,
  row: QueryResultRow,
  field: MarketField,
  value: unknown,
) {
  if (field.key === "name")
    await db.query(
      "UPDATE medicine_market_cards SET name=$2,normalized_name=$3,status='published',revision=revision+1,updated_at=now() WHERE id=$1",
      [row.id, value, norm(value as string)],
    );
  else
    await db.query(
      "UPDATE medicine_market_cards SET data=jsonb_set(data,ARRAY[$2]::text[],$3::jsonb,true),revision=revision+1,updated_at=now() WHERE id=$1",
      [row.id, field.key, json(value)],
    );
}
const createCardSchema = z
  .object({
    kind: z.enum(marketKinds),
    name: text.min(1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const contributionSchema = z
  .object({
    fieldKey: z.string().min(1).max(100),
    value: z.unknown(),
    expectedValue: z.unknown(),
    source: z.string().trim().max(1000).default(""),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const reviewContributionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1000).default(""),
  })
  .strict();

const pointPolicySchema = z
  .object({
    kind: z.enum(marketKinds),
    fieldKey: z.string(),
    addPoints: z.number().int().min(0).max(100000),
    editPoints: z.number().int().min(0).max(100000),
    revision: z.number().int().min(0),
  })
  .strict();

const archiveMarketCardSchema = z
  .object({
    archived: z.boolean(),
    revision: z.number().int().positive(),
  })
  .strict();

const commentMarketCardSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const reviewMarketCommentSchema = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();

const reactionMarketSchema = z
  .object({
    liked: z.boolean().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
  })
  .strict()
  .refine((x) => x.liked !== undefined || x.rating !== undefined);

export const mcpBodySchemas = {
  createCardSchema,
  contributionSchema,
  reviewContributionSchema,
  pointPolicySchema,
  archiveMarketCardSchema,
  commentMarketCardSchema,
  reviewMarketCommentSchema,
  reactionMarketSchema,
};

export function medicineMarketRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    root + "/meta",
    handler(async (req, res) => {
      const u = await viewer(pool, req),
        p = perms(u);
      await enabled(pool);
      const policies = (
        await pool.query("SELECT * FROM medicine_market_policies")
      ).rows;
      res.json({
        types: marketTypes.map((t) => ({
          ...t,
          fields: t.fields
            .filter((f) => canField(f, p))
            .map((f) => {
              const v = policies.find(
                (v) => v.kind === t.key && v.field_key === f.key,
              );
              return {
                ...f,
                points: { add: v?.add_points ?? 0, edit: v?.edit_points ?? 0 },
                policyRevision: v?.revision ?? 0,
              };
            }),
        })),
        permissions: p,
        userPoints: await points(pool, u?.id ?? null),
      });
    }),
  );
  router.get(
    root + "/cards",
    handler(async (req, res) => {
      const u = await viewer(pool, req),
        p = perms(u),
        v = pagination(req);
      await enabled(pool);
      const kind =
        req.query.kind === undefined || req.query.kind === ""
          ? null
          : parse(z.enum(marketKinds), req.query.kind);
      const archived = req.query.archived === "true";
      if (archived && !p.canModerate) deny();
      const query = norm(v.q).replace(/[\\%_]/g, "\\$&");
      const condition =
        "c.status='published' AND c.archived=$2 AND ($3::text IS NULL OR c.kind=$3) AND (c.normalized_name LIKE $4 ESCAPE '\\' OR lower(COALESCE(c.data->>'englishName','')) LIKE $4 ESCAPE '\\' OR lower(COALESCE(c.data->>'keywords','')) LIKE $4 ESCAPE '\\' OR c.id::text=$5)";
      const args = [u?.id ?? null, archived, kind, `%${query}%`, v.q];
      const rows = await pool.query(
        `${cardSelect} WHERE ${condition} ORDER BY c.updated_at DESC,c.id DESC LIMIT $6 OFFSET $7`,
        [...args, v.pageSize, v.offset],
      );
      const count = await pool.query(
        `SELECT count(*)::int total FROM medicine_market_cards c WHERE ($1::integer IS NULL OR $1::integer IS NOT NULL) AND ${condition}`,
        [...args],
      );
      res.json({
        items: rows.rows.map((r) => cardOutput(r, p)),
        total: count.rows[0].total,
        page: v.page,
        pageSize: v.pageSize,
      });
    }),
  );
  router.get(
    root + "/cards/:cardId",
    handler(async (req, res) => {
      const u = await viewer(pool, req),
        p = perms(u);
      await enabled(pool);
      const card = await getCard(pool, id(req.params.cardId), u);
      const comments = await pool.query(
        commentSelect +
          " WHERE p.card_id=$1 AND (p.status='approved' OR p.author_id=$2 OR $3) ORDER BY p.id DESC LIMIT 100",
        [card.id, u?.id ?? null, p.canModerate],
      );
      const contributions = await pool.query(
        contributionSelect +
          " WHERE p.card_id=$1 AND p.field_key=ANY($2::text[]) AND (p.status='approved' OR p.author_id=$3 OR $4) ORDER BY p.id DESC LIMIT 100",
        [card.id, readableKeys(p), u?.id ?? null, p.canModerate],
      );
      res.json({
        card: cardOutput(card, p),
        comments: comments.rows.map(commentOutput),
        contributions: contributions.rows.map(contributionOutput),
      });
    }),
  );
  router.post(
    root + "/cards",
    handler(async (req, res) => {
      const input = parse(createCardSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!,
          p = perms(u);
        const old = (
          await db.query(
            "SELECT * FROM medicine_market_cards WHERE created_by=$1 AND idempotency_key=$2",
            [u.id, input.idempotencyKey],
          )
        ).rows[0];
        if (old) {
          const original = (
            await db.query(
              "SELECT proposed_value FROM medicine_market_contributions WHERE card_id=$1 AND author_id=$2 AND idempotency_key=$3 AND field_key='name' AND previous_value='null'::jsonb",
              [old.id, u.id, input.idempotencyKey],
            )
          ).rows[0];
          if (
            old.kind !== input.kind ||
            !original ||
            original.proposed_value !== input.name
          )
            throw conflict("مفتاح الطلب مرتبط بكرت مختلف");
          return { card: cardOutput(await getCard(db, old.id, u), p) };
        }
        await enabled(db, "medicine-market", true);
        const duplicate = (
          await db.query(
            "SELECT id FROM medicine_market_cards WHERE kind=$1 AND normalized_name=$2 AND status<>'rejected'",
            [input.kind, norm(input.name)],
          )
        ).rows[0];
        if (duplicate)
          throw conflict(
            "يوجد كرت بالاسم نفسه؛ ابحث عنه قبل إنشاء كرت جديد، أو وضّح العبوة في الاسم",
          );
        const row = (
          await db.query(
            "INSERT INTO medicine_market_cards(kind,name,normalized_name,status,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              input.kind,
              input.name,
              norm(input.name),
              trusted(u) ? "published" : "pending",
              u.id,
              input.idempotencyKey,
            ],
          )
        ).rows[0];
        await db.query(
          "INSERT INTO medicine_market_contributions(card_id,field_key,previous_value,proposed_value,author_id,idempotency_key,published) VALUES($1,'name','null'::jsonb,$2,$3,$4,$5)",
          [row.id, json(input.name), u.id, input.idempotencyKey, trusted(u)],
        );
        await auditMarket(db, u, "create", row.id, null, {
          kind: row.kind,
          name: row.name,
          status: row.status,
        });
        return { card: cardOutput(row, p) };
      });
      res.status(201).json(result);
    }),
  );
  router.post(
    root + "/cards/:cardId/contributions",
    handler(async (req, res) => {
      const input = parse(contributionSchema, req.body);
      if (
        !Object.hasOwn(req.body, "value") ||
        !Object.hasOwn(req.body, "expectedValue")
      )
        throw new HttpError(
          400,
          "validation",
          "قيمة الحقل وقيمته السابقة مطلوبتان",
        );
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!,
          p = perms(u),
          card = await getCard(db, id(req.params.cardId), u, true),
          field = findField(card.kind, input.fieldKey);
        if (!canField(field, p)) deny();
        const value = normalizeValue(field, input.value),
          expected = normalizeValue(
            { ...field, key: field.key === "name" ? "oldName" : field.key },
            input.expectedValue,
          );
        const old = (
          await db.query(
            "SELECT id,card_id,field_key,proposed_value,previous_value,source FROM medicine_market_contributions WHERE author_id=$1 AND idempotency_key=$2",
            [u.id, input.idempotencyKey],
          )
        ).rows[0];
        if (old) {
          if (
            old.card_id !== card.id ||
            old.field_key !== field.key ||
            !same(old.proposed_value, value) ||
            !same(old.previous_value, expected) ||
            old.source !== input.source
          )
            throw conflict("مفتاح الطلب مرتبط بمساهمة مختلفة");
          return {
            contribution: contributionOutput(
              await contributionById(db, old.id),
            ),
            card: cardOutput(card, p),
          };
        }
        await enabled(db, "medicine-market", true);
        if (card.archived || card.status === "rejected")
          deny("هذا الكرت مؤرشف أو مرفوض");
        const previous =
          field.key === "name" ? card.name : (card.data[field.key] ?? null);
        if (!same(previous, expected)) throw conflict();
        if (same(previous, value))
          throw new HttpError(400, "unchanged", "لم تتغير قيمة الحقل");
        if (
          field.key === "name" &&
          norm(previous as string) === norm(value as string)
        )
          throw new HttpError(400, "unchanged", "التعديل شكلي ولا يغيّر الاسم");
        await validateReferences(db, field, value);
        const published =
          trusted(u) && !field.price && card.status === "published";
        const contribution = (
          await db.query(
            "INSERT INTO medicine_market_contributions(card_id,field_key,previous_value,proposed_value,source,author_id,idempotency_key,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
            [
              card.id,
              field.key,
              json(previous),
              json(value),
              input.source,
              u.id,
              input.idempotencyKey,
              published,
            ],
          )
        ).rows[0];
        if (published) await applyField(db, card, field, value);
        const protectedValue = field.visibility !== "public";
        await auditMarket(
          db,
          u,
          "contribute",
          card.id,
          { field: field.key, value: protectedValue ? "[محمي]" : previous },
          {
            contributionId: contribution.id,
            field: field.key,
            value: protectedValue ? "[محمي]" : value,
            published,
          },
        );
        return {
          contribution: contributionOutput(
            await contributionById(db, contribution.id),
          ),
          card: cardOutput(await getCard(db, card.id, u), p),
        };
      });
      res.status(201).json(result);
    }),
  );
  router.get(
    root + "/contributions",
    handler(async (req, res) => {
      const u = (await viewer(pool, req)) ?? actor(req),
        p = perms(u),
        v = pagination(req);
      const mine = req.query.mine === "true" || !p.canModerate;
      await enabled(
        pool,
        mine ? "medicine-market-contributions" : "medicine-market-review",
      );
      const status = req.query.status
        ? parse(
            z.enum(["pending", "approved", "rejected", "conflict"]),
            req.query.status,
          )
        : null;
      const args = [mine ? u.id : null, status, readableKeys(p)];
      const condition =
        "($1::integer IS NULL OR p.author_id=$1) AND ($2::text IS NULL OR p.status=$2) AND p.field_key=ANY($3::text[])";
      const rows = await pool.query(
        contributionSelect +
          ` WHERE ${condition} ORDER BY p.id DESC LIMIT $4 OFFSET $5`,
        [...args, v.pageSize, v.offset],
      );
      const count = await pool.query(
        `SELECT count(*)::int total FROM medicine_market_contributions p WHERE ${condition}`,
        args,
      );
      res.json({
        items: rows.rows.map(contributionOutput),
        total: count.rows[0].total,
        page: v.page,
        pageSize: v.pageSize,
      });
    }),
  );
  router.post(
    root + "/contributions/:contributionId/review",
    handler(async (req, res) => {
      const input = parse(reviewContributionSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!,
          p = perms(u);
        if (!p.canModerate) deny();
        await enabled(db, "medicine-market-review", true);
        const targetId = id(req.params.contributionId),
          hint =
            (
              await db.query(
                "SELECT card_id FROM medicine_market_contributions WHERE id=$1",
                [targetId],
              )
            ).rows[0] ?? missing();
        const card = await getCard(db, hint.card_id, u, true);
        const c =
          (
            await db.query(
              "SELECT * FROM medicine_market_contributions WHERE id=$1 FOR UPDATE",
              [targetId],
            )
          ).rows[0] ?? missing();
        const field = findField(card.kind, c.field_key);
        if (!canField(field, p)) deny();
        if (c.status !== "pending") {
          if (
            (c.status === "approved" && input.decision === "approve") ||
            (c.status === "rejected" && input.decision === "reject")
          )
            return {
              contribution: contributionOutput(
                await contributionById(db, c.id),
              ),
              card: cardOutput(card, p),
            };
          throw conflict("انتهت مراجعة هذه المساهمة");
        }
        let status = input.decision === "approve" ? "approved" : "rejected",
          awarded = 0;
        const nowValue =
          field.key === "name" ? card.name : (card.data[field.key] ?? null);
        if (input.decision === "approve") {
          if (
            card.archived ||
            card.status === "rejected" ||
            !(c.published
              ? same(nowValue, c.proposed_value)
              : field.key === "name" && card.status === "pending"
                ? same(nowValue, c.proposed_value)
                : same(nowValue, c.previous_value))
          )
            status = "conflict";
          else {
            await validateReferences(db, field, c.proposed_value);
            if (!c.published)
              await applyField(db, card, field, c.proposed_value);
            const policy = (
              await db.query(
                "SELECT * FROM medicine_market_policies WHERE kind=$1 AND field_key=$2 FOR SHARE",
                [card.kind, field.key],
              )
            ).rows[0];
            const action = c.previous_value === null ? "add" : "edit";
            awarded =
              c.author_id === u.id
                ? 0
                : ((action === "add"
                    ? policy?.add_points
                    : policy?.edit_points) ?? 0);
            await db.query(
              "INSERT INTO medicine_market_points(contribution_id,user_id,points,policy_snapshot) VALUES($1,$2,$3,$4)",
              [
                c.id,
                c.author_id,
                awarded,
                json({
                  kind: card.kind,
                  fieldKey: field.key,
                  action,
                  revision: policy?.revision ?? 0,
                  addPoints: policy?.add_points ?? 0,
                  editPoints: policy?.edit_points ?? 0,
                  selfReview: c.author_id === u.id,
                }),
              ],
            );
          }
        } else if (
          !c.published &&
          field.key === "name" &&
          card.status === "pending"
        )
          await db.query(
            "UPDATE medicine_market_cards SET status='rejected',revision=revision+1,updated_at=now() WHERE id=$1",
            [card.id],
          );
        // Rejected directly-published proposals retain the current value; a corrective
        // field proposal is explicit and revision checked, never silently reverts newer work.
        await db.query(
          "UPDATE medicine_market_contributions SET status=$2,awarded_points=$3,reviewer_id=$4,reviewed_at=now(),reason=$5 WHERE id=$1",
          [
            c.id,
            status,
            awarded,
            u.id,
            status === "conflict"
              ? "تغيرت القيمة أو حالة الكرت قبل الاعتماد"
              : input.reason,
          ],
        );
        await auditMarket(
          db,
          u,
          "review",
          card.id,
          { contributionId: c.id, status: "pending" },
          { contributionId: c.id, status, awardedPoints: awarded },
        );
        return {
          contribution: contributionOutput(await contributionById(db, c.id)),
          card: cardOutput(await getCard(db, card.id, u), p),
        };
      });
      res.json(result);
    }),
  );
  router.put(
    root + "/policies",
    handler(async (req, res) => {
      const input = parse(pointPolicySchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!;
        if (!perms(u).canConfigure) deny();
        await enabled(db, "medicine-market-points", true);
        findField(input.kind, input.fieldKey);
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `medicine-market-policy:${input.kind}:${input.fieldKey}`,
        ]);
        const old = (
          await db.query(
            "SELECT * FROM medicine_market_policies WHERE kind=$1 AND field_key=$2 FOR UPDATE",
            [input.kind, input.fieldKey],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== input.revision)
          throw conflict("تغيرت سياسة النقاط؛ حدّث الصفحة");
        const row = (
          await db.query(
            "INSERT INTO medicine_market_policies(kind,field_key,add_points,edit_points) VALUES($1,$2,$3,$4) ON CONFLICT(kind,field_key) DO UPDATE SET add_points=EXCLUDED.add_points,edit_points=EXCLUDED.edit_points,revision=medicine_market_policies.revision+1 RETURNING *",
            [input.kind, input.fieldKey, input.addPoints, input.editPoints],
          )
        ).rows[0];
        await auditMarket(
          db,
          u,
          "policy",
          null,
          old
            ? {
                kind: old.kind,
                fieldKey: old.field_key,
                addPoints: old.add_points,
                editPoints: old.edit_points,
                revision: old.revision,
              }
            : null,
          { ...input, revision: row.revision },
        );
        return { revision: row.revision };
      });
      res.json(result);
    }),
  );
  router.patch(
    root + "/cards/:cardId/archive",
    handler(async (req, res) => {
      const input = parse(archiveMarketCardSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!;
        if (!perms(u).canArchive) deny();
        await enabled(db, "medicine-market", true);
        const card = await getCard(db, id(req.params.cardId), u, true);
        if (card.revision !== input.revision) throw conflict();
        await db.query(
          "UPDATE medicine_market_cards SET archived=$2,revision=revision+1,updated_at=now() WHERE id=$1",
          [card.id, input.archived],
        );
        await auditMarket(
          db,
          u,
          "archive",
          card.id,
          { archived: card.archived },
          { archived: input.archived },
        );
        return { card: cardOutput(await getCard(db, card.id, u), perms(u)) };
      });
      res.json(result);
    }),
  );
  router.post(
    root + "/cards/:cardId/comments",
    handler(async (req, res) => {
      const input = parse(commentMarketCardSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!,
          card = await getCard(db, id(req.params.cardId), u, true);
        if (card.status !== "published" || card.archived) deny();
        const old = (
          await db.query(
            commentSelect + " WHERE p.author_id=$1 AND p.idempotency_key=$2",
            [u.id, input.idempotencyKey],
          )
        ).rows[0];
        if (old) {
          if (old.card_id !== card.id || old.text !== input.text)
            throw conflict();
          return { comment: commentOutput(old) };
        }
        await enabled(db, "medicine-market", true);
        const row = (
          await db.query(
            "INSERT INTO medicine_market_comments(card_id,author_id,text,status,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              card.id,
              u.id,
              input.text,
              trusted(u) ? "approved" : "pending",
              input.idempotencyKey,
            ],
          )
        ).rows[0];
        await auditMarket(db, u, "comment", card.id, null, {
          commentId: row.id,
          status: trusted(u) ? "approved" : "pending",
        });
        return {
          comment: commentOutput(
            (await db.query(commentSelect + " WHERE p.id=$1", [row.id]))
              .rows[0],
          ),
        };
      });
      res.status(201).json(result);
    }),
  );
  router.get(
    root + "/comments",
    handler(async (req, res) => {
      const u = (await viewer(pool, req)) ?? actor(req);
      if (!perms(u).canModerate) deny();
      await enabled(pool, "medicine-market-review");
      const v = pagination(req),
        status = parse(
          z.enum(["pending", "approved", "rejected"]),
          req.query.status ?? "pending",
        );
      const rows = await pool.query(
        commentSelect +
          " WHERE p.status=$1 ORDER BY p.id DESC LIMIT $2 OFFSET $3",
        [status, v.pageSize, v.offset],
      );
      const total = (
        await pool.query(
          "SELECT count(*)::int total FROM medicine_market_comments WHERE status=$1",
          [status],
        )
      ).rows[0].total;
      res.json({
        items: rows.rows.map(commentOutput),
        total,
        page: v.page,
        pageSize: v.pageSize,
      });
    }),
  );
  router.post(
    root + "/comments/:commentId/review",
    handler(async (req, res) => {
      const input = parse(reviewMarketCommentSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!;
        if (!perms(u).canModerate) deny();
        await enabled(db, "medicine-market-review", true);
        const c =
          (
            await db.query(
              "SELECT * FROM medicine_market_comments WHERE id=$1 FOR UPDATE",
              [id(req.params.commentId)],
            )
          ).rows[0] ?? missing();
        const status = input.decision === "approve" ? "approved" : "rejected";
        if (c.status !== "pending") {
          if (c.status !== status) throw conflict("سبق مراجعة التعليق");
          return {
            comment: commentOutput(
              (await db.query(commentSelect + " WHERE p.id=$1", [c.id]))
                .rows[0],
            ),
          };
        }
        await db.query(
          "UPDATE medicine_market_comments SET status=$2,reviewer_id=$3,reviewed_at=now() WHERE id=$1",
          [c.id, status, u.id],
        );
        await auditMarket(
          db,
          u,
          "review-comment",
          c.card_id,
          { commentId: c.id, status: c.status },
          { commentId: c.id, status },
        );
        return {
          comment: commentOutput(
            (await db.query(commentSelect + " WHERE p.id=$1", [c.id])).rows[0],
          ),
        };
      });
      res.json(result);
    }),
  );
  router.put(
    root + "/cards/:cardId/reaction",
    handler(async (req, res) => {
      const input = parse(reactionMarketSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const u = (await viewer(db, req, true))!;
        await enabled(db, "medicine-market", true);
        const card = await getCard(db, id(req.params.cardId), u, true);
        if (card.status !== "published" || card.archived) deny();
        const old = (
          await db.query(
            "SELECT * FROM medicine_market_reactions WHERE card_id=$1 AND user_id=$2",
            [card.id, u.id],
          )
        ).rows[0];
        const before = {
          liked: old?.liked ?? false,
          rating: old?.rating ?? null,
        };
        const after = {
          liked: input.liked ?? before.liked,
          rating: input.rating === undefined ? before.rating : input.rating,
        };
        await db.query(
          "INSERT INTO medicine_market_reactions(card_id,user_id,liked,rating) VALUES($1,$2,$3,$4) ON CONFLICT(card_id,user_id) DO UPDATE SET liked=EXCLUDED.liked,rating=EXCLUDED.rating",
          [card.id, u.id, after.liked, after.rating],
        );
        if (!same(before, after))
          await auditMarket(db, u, "reaction", card.id, before, after);
        return { card: cardOutput(await getCard(db, card.id, u), perms(u)) };
      });
      res.json(result);
    }),
  );
  router.get(
    root + "/me",
    handler(async (req, res) => {
      const u = (await viewer(pool, req)) ?? actor(req);
      await enabled(pool, "medicine-market-contributions");
      const rows = (
        await pool.query(
          "SELECT status,count(*)::int total FROM medicine_market_contributions WHERE author_id=$1 GROUP BY status",
          [u.id],
        )
      ).rows;
      res.json({
        points: await points(pool, u.id),
        approved: rows.find((r) => r.status === "approved")?.total ?? 0,
        pending: rows.find((r) => r.status === "pending")?.total ?? 0,
      });
    }),
  );
  return router;
}

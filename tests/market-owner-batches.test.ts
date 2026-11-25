import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";
import type { User } from "../packages/contracts/src/index.ts";
import { medicineMarketRoutes, mcpBodySchemas } from "../apps/api/src/routes-medicine-market.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { validateModernProductImageUrl, downloadPublicImage } from "../apps/api/src/market/image-variants.ts";
import { HttpError } from "../apps/api/src/errors.ts";

// Real PostgreSQL semantics in an isolated WASM database. Serialize client
// acquisition, as PGlite has one connection; concurrent HTTP calls remain real.
function adapter(db: PGlite) {
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous; return release;
  };
  const query = async (sql: string, args?: unknown[]) => {
    const result = await db.query(sql, args);
    return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
  };
  return {
    async query(sql: string, args?: unknown[]) { const release = await acquire(); try { return await query(sql, args); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; },
  } as unknown as Pool;
}
const owner = { id: 1, name: "Owner", displayName: "Owner", owner: true, kind: "admin", suspended: false, archived: false } as User;
const member = { ...owner, id: 2, owner: false, kind: "member" } as User;
const admin = { ...member, id: 3, kind: "admin" } as User;
const monitor = { ...member, id: 4, monitor: true } as User;

function contribution(cardId: number, fieldKey: string, value: unknown, expectedValue: unknown = null) {
  return { cardId, fieldKey, value, expectedValue, source: "isolated test", idempotencyKey: randomUUID() };
}

test("Modern product image source rules reject unrelated URLs before any network request", async () => {
  const valid = "https://modernpharmaye.com/upload/products/packs/original/abc123.jpeg";
  assert.equal(validateModernProductImageUrl(valid).hostname, "modernpharmaye.com");
  for (const source of [
    "https://other.example/upload/products/packs/original/a.jpg",
    "http://modernpharmaye.com/upload/products/packs/original/a.jpg",
    "https://modernpharmaye.com.evil.example/upload/products/packs/original/a.jpg",
    "https://modernpharmaye.com/upload/products/packs/small/a.jpg",
    "https://modernpharmaye.com/upload/products/packs/original/a.jpg?next=https://127.0.0.1",
    "https://modernpharmaye.com/upload/products/packs/original/a.jpg#x",
    "https://u:p@modernpharmaye.com/upload/products/packs/original/a.jpg",
    "https://modernpharmaye.com:8080/upload/products/packs/original/a.jpg",
    "https://modernpharmaye.com/upload/products/packs/original/%2e%2e/a.jpg",
    "https://127.0.0.1/upload/products/packs/original/a.jpg",
  ]) {
    assert.throws(() => validateModernProductImageUrl(source), source);
    // The per-hop validator runs before DNS, so invalid imports cannot make a request.
    await assert.rejects(downloadPublicImage(source, validateModernProductImageUrl), source);
  }
});

test("owner enrichment batches preserve atomic contributions and medicine image boundaries", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(await readFile("apps/api/market-migrations/001_market.sql", "utf8"));
  await db.exec(`INSERT INTO users(id,display_name) VALUES(1,'Owner'),(2,'Member');
    CREATE TABLE market_reference_entries(kind text,code text);
    INSERT INTO market_reference_entries VALUES('country','YE');
    CREATE TABLE market_card_statistics(card_id integer PRIMARY KEY,likes integer DEFAULT 0,opens integer DEFAULT 0,
      comments integer DEFAULT 0,relations jsonb DEFAULT '{}',rating_average numeric,rating_count integer DEFAULT 0);
    CREATE FUNCTION market_relation_counts(integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE market_image_uploads(id uuid PRIMARY KEY,card_id integer REFERENCES medicine_market_cards(id),
      uploaded_by integer REFERENCES users(id),byte_size integer,image_bytes bytea,width integer,height integer,
      created_at timestamptz DEFAULT now());`);
  await db.exec(await readFile("apps/api/market-migrations/20261112_market_image_variants.sql", "utf8"));
  await db.exec(await readFile("apps/api/market-migrations/20261112_market_images_two_copies.sql", "utf8"));
  const ids: Record<string, number> = {};
  for (const [key, kind] of [["medicine", "medicine"], ["second", "medicine"], ["composition", "composition"], ["scientific", "scientific-name"], ["form", "dosage-form"], ["agent", "agent"]]) {
    const row = await db.query<{ id: number }>("INSERT INTO medicine_market_cards(kind,name,normalized_name,status,created_by,idempotency_key) VALUES($1,$2,$2,'published',1,$3) RETURNING id", [kind, key, randomUUID()]);
    ids[key!] = row.rows[0]!.id;
  }
  await db.exec("INSERT INTO market_card_statistics(card_id) SELECT id FROM medicine_market_cards");
  const pool = adapter(db), app = express();
  app.use(express.json({ limit: "768kb" }));
  app.use((req, _res, next) => {
    if (req.get("x-test-user") === "visitor") req.auth = { user: owner, visitorOnly: true, tokenHash: "", csrf: "" };
    next();
  });
  const router = medicineMarketRoutes(pool, {
    async viewer(_db, req, write = false) {
      const who = req.get("x-test-user");
      const user = who === "owner" || who === "visitor" ? owner : who === "member" ? member :
        who === "admin" ? admin : who === "monitor" ? monitor :
        who === "suspended" ? { ...owner, suspended: true } : who === "archived" ? { ...owner, archived: true } : null;
      if (write && !user) throw new HttpError(401, "unauthenticated", "test login required");
      return user;
    },
    async enabled(_db, req) { if (req.get("x-test-disabled")) throw new HttpError(403, "disabled", "test page disabled"); },
  }, true);
  app.use(router);
  app.use(((error, _req, res, _next) => {
    res.status(error instanceof z.ZodError ? 400 : error.status ?? 500).json({ error: { code: error.code ?? "test_error", message: error.message } });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/medicine-market`;
  const call = async (path: string, body: unknown, who = "owner", disabled = false) => {
    const response = await fetch(root + path, { method: "POST", headers: { "content-type": "application/json", "x-test-user": who,
      ...(disabled ? { "x-test-disabled": "1" } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)).rows[0]!.n;
  const snapshot = async () => ({
    contributions: await count("medicine_market_contributions"), audit: await count("audit_events"),
    uploads: await count("market_image_uploads"), variants: await count("market_image_variants"),
    cards: (await db.query("SELECT id,data,revision FROM medicine_market_cards ORDER BY id")).rows,
  });
  const art = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#203040" } }).png().toBuffer();
  const bytes = await sharp({ create: { width: 200, height: 120, channels: 3, background: "white" } })
    .composite([{ input: art, left: 60, top: 40 }]).webp({ lossless: true }).toBuffer();
  const photo = { cardId: ids.medicine, dataUrl: `data:image/webp;base64,${bytes.toString("base64")}`, cropWhitespace: true };

  await t.test("catalog exposes both exact strict schemas and non-owners cannot write", async () => {
    for (const [path, schema] of [["contributions-batch", "ownerContributionsBatchSchema"], ["images-batch", "ownerImagesBatchSchema"]] as const) {
      const entry = apiCatalog(router, { operation: `POST /medicine-market/owner/${path}` }).operations[0];
      assert(entry); assert("bodySchema" in entry); assert.deepEqual(entry.bodySchema, z.toJSONSchema(mcpBodySchemas[schema]));
    }
    const before = await snapshot();
    for (const who of ["member", "visitor", "suspended", "archived", ""]) {
      const expected = who ? 403 : 401;
      assert.equal((await call("/owner/contributions-batch", { items: [contribution(ids.medicine!, "englishName", "Test")] }, who)).status, expected);
      assert.equal((await call("/owner/images-batch", { items: [photo] }, who)).status, expected);
    }
    assert.equal((await call("/owner/contributions-batch", { items: [contribution(ids.medicine!, "englishName", "Test")] }, "owner", true)).status, 403);
    assert.equal((await call("/owner/images-batch", { items: [photo] }, "owner", true)).status, 403);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test("batch bounds, financial/name exclusion and explicit expected values reject without writes", async () => {
    const before = await snapshot();
    for (const field of ["name", "purchasePrice", "defaultSalePrice", "accountingMappings", "ministryNotes"])
      assert.equal((await call("/owner/contributions-batch", { items: [contribution(ids.medicine!, field, "ignored")] })).status, 400);
    const missing = contribution(ids.medicine!, "englishName", "Test"); delete (missing as any).expectedValue;
    assert.equal((await call("/owner/contributions-batch", { items: [missing] })).status, 400);
    assert.equal((await call("/owner/contributions-batch", { items: Array.from({ length: 51 }, () => contribution(ids.medicine!, "englishName", "Test")) })).status, 400);
    assert.equal((await call("/owner/images-batch", { items: Array.from({ length: 11 }, () => photo) })).status, 400);
    assert.equal((await call("/owner/images-batch", { items: [photo, { ...photo, sourceUrl: "https://modernpharmaye.com/upload/products/packs/original/a.jpg" }] })).status, 400);
    assert.equal((await call("/owner/images-batch", { items: [{ cardId: ids.medicine, sourceUrl: "https://127.0.0.1/a.jpg" }] })).status, 400);
    assert.equal((await call("/owner/images-batch", { items: Array.from({ length: 10 }, () => ({ ...photo, dataUrl: "x".repeat(80000) })) })).status, 413);
    assert.deepEqual(await snapshot(), before);
  });
  const successful = { items: [
    contribution(ids.medicine!, "englishName", " Test Medicine "),
    contribution(ids.medicine!, "dosageFormId", ids.form),
    contribution(ids.composition!, "ingredients", [{ scientificId: ids.scientific, strength: "500.00", unit: "mg" }]),
  ] };
  let saved: any;
  await t.test("normalization, references, field audit and automatic owner approval match single writes", async () => {
    saved = await call("/owner/contributions-batch", successful);
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.items.length, 3);
    assert(saved.data.items.every((item: any) => item.published && item.status === "approved"));
    assert.equal(saved.data.cards.find((card: any) => card.id === ids.medicine).data.englishName, "Test Medicine");
    const composition = saved.data.cards.find((card: any) => card.id === ids.composition);
    assert.equal(composition.data.ingredients[0].strength, "500");
    assert.equal(await count("medicine_market_contributions"), 3); assert.equal(await count("audit_events"), 3);
    const approvals = (await db.query<{ reviewer_id: number; reviewed_at: Date | null }>("SELECT reviewer_id,reviewed_at FROM medicine_market_contributions")).rows;
    assert(approvals.every(row => row.reviewer_id === owner.id && row.reviewed_at));
    const single = contribution(ids.second!, "keywords", "single path");
    const { cardId, ...body } = single;
    assert.equal((await call(`/cards/${cardId}/contributions`, body)).status, 201);
  });
  await t.test("invalid references and late expected-value conflicts roll back earlier items and audits", async () => {
    const before = await snapshot();
    const invalid = await call("/owner/contributions-batch", { items: [
      contribution(ids.medicine!, "keywords", "must roll back"),
      contribution(ids.medicine!, "compositionId", ids.agent),
    ] });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
    assert.deepEqual(await snapshot(), before);
    const stale = await call("/owner/contributions-batch", { items: [
      contribution(ids.medicine!, "keywords", "must roll back"),
      contribution(ids.medicine!, "englishName", "outdated update", null),
    ] });
    assert.equal(stale.status, 409); assert.deepEqual(await snapshot(), before);
  });
  await t.test("UUID replay is unchanged and competing expected-value updates cannot overwrite", async () => {
    const before = await snapshot(), replay = await call("/owner/contributions-batch", successful);
    assert.equal(replay.status, 201); assert.deepEqual(replay.data.items, saved.data.items);
    assert.deepEqual(await snapshot(), before);
    const altered = structuredClone(successful); altered.items[0]!.value = "different";
    assert.equal((await call("/owner/contributions-batch", altered)).status, 409);
    assert.deepEqual(await snapshot(), before);
    const competing = await Promise.all(["winner A", "winner B"].map(value => call("/owner/contributions-batch", {
      items: [contribution(ids.medicine!, "keywords", value)],
    })));
    assert.deepEqual(competing.map(result => result.status).sort(), [201, 409]);
    assert.equal(await count("medicine_market_contributions"), before.contributions + 1);
    assert.equal(await count("audit_events"), before.audit + 1);
  });
  await t.test("image storage is atomic, medicine-only and does not link the card image", async () => {
    const before = await snapshot();
    const crossKind = await call("/owner/images-batch", { items: [photo, { ...photo, cardId: ids.agent }] });
    assert.equal(crossKind.status, 400); assert.equal(crossKind.data.error.code, "image_batch_kind");
    assert.deepEqual(await snapshot(), before);
    const badDecode = await call("/owner/images-batch", { items: [photo, { ...photo, dataUrl: "data:image/webp;base64," + "A".repeat(60) }] });
    assert.equal(badDecode.status, 400); assert.deepEqual(await snapshot(), before);
    const uploaded = await call("/owner/images-batch", { items: [photo, { ...photo, cardId: ids.second }] });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.items.length, 2);
    assert(uploaded.data.items.every((image: any) => image.width < 200 && image.height < 120 && image.bytes <= 204800 && image.iconBytes <= 16384));
    assert.equal(await count("market_image_uploads"), before.uploads + 2);
    assert.equal(await count("market_image_variants"), before.variants + 2);
    assert.equal(await count("audit_events"), before.audit + 2);
    assert.deepEqual((await snapshot()).cards, before.cards, "upload must not set image fields or revisions");
    const stored = (await db.query<{ preview_bytes: Uint8Array | null; storage_version: number }>("SELECT preview_bytes,storage_version FROM market_image_variants")).rows;
    assert(stored.every(row => row.preview_bytes === null && row.storage_version === 2), "main+icon only; no third persisted copy");
  });
  await t.test("only an active owner can recover matching stored image receipts from audit", async () => {
    const uploads = (await db.query<{
      id: string; card_id: number; uploaded_by: number; byte_size: number;
      width: number; height: number; created_at: Date;
    }>("SELECT id,card_id,uploaded_by,byte_size,width,height,created_at FROM market_image_uploads ORDER BY card_id")).rows;
    assert.equal(uploads.length, 2, "the preceding image batch created real stored uploads");
    const first = uploads[0]!, second = uploads[1]!;
    const privateMarker = "private-source-url-must-not-be-returned";
    // Receipt dimensions and bytes must come from the stored upload, not untrusted audit metadata.
    await db.query("UPDATE audit_events SET after_value=after_value || $1::jsonb WHERE action='image_upload'", [
      { size: -1, width: 99999, height: 99999, sourceUrl: privateMarker, rawMetadata: privateMarker },
    ]);
    const invalidEvents: number[] = [];
    for (const [cardId, actorId, imageId, action] of [
      [first.card_id, first.uploaded_by, second.id, "image_upload"],
      [first.card_id, member.id, first.id, "image_upload"],
      [first.card_id, first.uploaded_by, randomUUID(), "image_upload"],
      [first.card_id, first.uploaded_by, "not-a-uuid", "image_upload"],
      [first.card_id, first.uploaded_by, first.id, "field_change"],
    ] as const) {
      const result = await db.query<{ id: number }>(
        "INSERT INTO audit_events(actor_id,actor_name,scope,action,target_type,target_id,after_value) " +
        "VALUES($1,'Test','public',$2,'medicine-market',$3,$4) RETURNING id",
        [actorId, action, cardId, { imageId, sourceUrl: privateMarker }],
      );
      invalidEvents.push(Number(result.rows[0]!.id));
    }
    const before = await snapshot();
    const audit = async (who: string) => {
      const response = await fetch(root + "/audit?pageSize=100", { headers: { "x-test-user": who } });
      return { status: response.status, data: await response.json() as any };
    };
    const recovered = await audit("owner");
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    const receipts = recovered.data.items.filter((item: any) => item.imageUpload != null);
    assert.equal(receipts.length, uploads.length, "only matching image-upload events expose receipts");
    for (const upload of uploads) {
      const event = receipts.find((item: any) => item.imageUpload.imageId === upload.id);
      assert(event, "a stored upload remains recoverable even before it is linked to the card");
      const receipt = event.imageUpload;
      assert.deepEqual(Object.keys(receipt).sort(), ["imageId", "cardId", "url", "createdAt", "bytes", "width", "height"].sort());
      assert.equal(receipt.cardId, upload.card_id);
      assert.equal(Number(event.target_id), upload.card_id);
      assert.equal(receipt.url, `/api/medicine-market/images/${upload.id}`);
      assert.equal(receipt.bytes, upload.byte_size);
      assert.equal(receipt.width, upload.width);
      assert.equal(receipt.height, upload.height);
      assert.equal(new Date(receipt.createdAt).getTime(), new Date(upload.created_at).getTime());
    }
    for (const eventId of invalidEvents) {
      const event = recovered.data.items.find((item: any) => Number(item.id) === eventId);
      assert(event, "unmatched events remain visible as ordinary audit rows");
      assert.equal(event.imageUpload == null, true, "a wrong card, actor, action or missing image cannot produce a receipt");
    }
    assert(!JSON.stringify(recovered.data).includes(privateMarker));
    assert(recovered.data.items.every((item: any) => !Object.hasOwn(item, "after_value") && !Object.hasOwn(item, "before_value")));
    assert.equal((await audit("member")).status, 403);
    for (const who of ["admin", "monitor"]) {
      const result = await audit(who);
      assert.equal(result.status, 200, who);
      assert(result.data.items.every((item: any) => !Object.hasOwn(item, "imageUpload")), who + " may inspect audit, not upload receipts");
      assert(!JSON.stringify(result.data).includes(privateMarker));
    }
    for (const who of ["visitor", "suspended", "archived"]) {
      const result = await audit(who);
      assert([200, 401, 403].includes(result.status), who);
      if (result.status === 200) assert(result.data.items.every((item: any) => item.imageUpload == null), who + " has no active owner authority");
    }
    assert.deepEqual(await snapshot(), before, "receipt recovery only reads existing uploads and audit events");
  });
});

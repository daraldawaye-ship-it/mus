import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import express from "express";
import { Pool } from "pg";
import sharp from "sharp";
import { buildMarketImageVariants, isPublicImageAddress, validateExternalImageUrl } from "../apps/api/src/market/image-variants.ts";
import { marketTypes } from "../packages/contracts/src/medicine-market.ts";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import type { User } from "../packages/contracts/src/index.ts";

const photo = () => sharp({ create: { width: 512, height: 256, channels: 4, background: { r: 30, g: 120, b: 180, alpha: 0.7 } } }).webp().toBuffer();

test("all market card kinds except compositions expose exactly one image field", () => {
  for (const kind of marketTypes)
    assert.equal(kind.fields.filter(field => field.key === "image").length, kind.key === "composition" ? 0 : 1, kind.key);
});
test("variants preserve aspect ratio and keep icon/preview byte bounds", async () => {
  const original = await photo(); const variants = await buildMarketImageVariants(original);
  assert.equal(variants.iconWidth, 64); assert.equal(variants.iconHeight, 32);
  assert.equal(variants.previewWidth, 240); assert.equal(variants.previewHeight, 120);
  assert.ok(variants.icon.length <= 16 * 1024); assert.ok(variants.preview.length <= 64 * 1024);
  assert.equal((await sharp(variants.icon).metadata()).format, "webp");
  assert.equal((await sharp(variants.preview).metadata()).exif, undefined);
  await assert.rejects(buildMarketImageVariants(Buffer.from("not an image")));
  await assert.rejects(buildMarketImageVariants(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50"/></svg>')));
});
test("remote source checks refuse private, alternate-IP, metadata and credentialed URLs", () => {
  for (const address of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "172.16.1.1", "192.168.0.1", "100.64.0.1", "224.1.1.1", "::1", "::ffff:127.0.0.1"])
    assert.equal(isPublicImageAddress(address), false, address);
  assert.equal(isPublicImageAddress("1.1.1.1"), true);
  for (const url of ["http://example.com/a.png", "https://localhost/a.png", "https://127.1/a.png", "https://2130706433/a.png", "https://[::1]/a.png", "https://u:p@example.com/a.png", "https://example.com:8080/a.png"])
    assert.throws(() => validateExternalImageUrl(url), url);
});

test("isolated image routes enforce visibility, admin rules, byte sizes and cascade cleanup", { skip: !process.env.TEST_IMAGE_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_IMAGE_DATABASE_URL });
  const schema = `image_test_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_IMAGE_DATABASE_URL, options: `-c search_path=${schema}` });
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await pool.query(`
      CREATE TABLE medicine_market_cards(id serial PRIMARY KEY,kind text NOT NULL,name text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'published',archived boolean NOT NULL DEFAULT false,
        created_by integer NOT NULL DEFAULT 1,revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE medicine_market_reactions(card_id integer,user_id integer,liked boolean,rating integer);
      CREATE TABLE market_image_uploads(id uuid PRIMARY KEY,card_id integer REFERENCES medicine_market_cards(id),
        uploaded_by integer,byte_size integer,image_bytes bytea,width integer,height integer,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,action text,
        target_type text,target_id integer,before_value jsonb,after_value jsonb);
      INSERT INTO medicine_market_cards(id,kind,name,status) VALUES
        (1,'medicine','Test medicine','published'),(2,'composition','Test composition','published'),
        (3,'prescription','Private prescription','pending'),(4,'agent','Test agent','published'),
        (5,'dosage-form','Test form','published');
    `);
    await pool.query(await readFile(new URL("../apps/api/market-migrations/20261112_market_image_variants.sql", import.meta.url), "utf8"));
    const owner = { id: 1, displayName: "Test owner", owner: true, kind: "admin", suspended: false, archived: false } as User;
    const member = { ...owner, id: 2, owner: false, kind: "member" } as User;
    const app = express(); app.use(express.json({ limit: "768kb" }));
    app.use(medicineMarketRoutes(pool, {
      async viewer(_db, req, write = false) {
        const user = req.get("x-test-user") === "owner" ? owner : req.get("x-test-user") === "member" ? member : null;
        if (write && !user) throw new HttpError(401, "unauthenticated", "Test authentication");
        return user;
      }, async enabled() {},
    }, true));
    app.use(((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = error instanceof HttpError ? error : new HttpError(500, "test_failure", String(error));
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
    }) as express.ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const root = `http://127.0.0.1:${address.port}/medicine-market`;
    const original = await photo(); const dataUrl = `data:image/webp;base64,${original.toString("base64")}`;
    const upload = (id: number, user = "owner") => fetch(`${root}/cards/${id}/images`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-user": user }, body: JSON.stringify({ dataUrl }),
    });
    assert.equal((await upload(2)).status, 400, "composition cannot acquire an image");
    assert.equal((await upload(5, "member")).status, 403, "admin reference upload remains restricted");
    const uploaded = await upload(4); assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const result = await uploaded.json() as { url: string };
    await pool.query("UPDATE medicine_market_cards SET data=jsonb_build_object('image',$1::text) WHERE id=4", [result.url]);
    const icon = await fetch(`${root}/cards/4/image-variants/icon?v=1`);
    assert.equal(icon.status, 200); assert.match(icon.headers.get("content-type") ?? "", /image\/webp/);
    assert.equal((await sharp(Buffer.from(await icon.arrayBuffer())).metadata()).width, 64);
    const preview = await fetch(`http://127.0.0.1:${address.port}${result.url.replace(/^\/api/, "")}?variant=preview`);
    assert.equal(preview.status, 200);
    assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 240);
    const privateUpload = await upload(3); assert.equal(privateUpload.status, 201);
    const privateImage = await privateUpload.json() as { url: string };
    await pool.query("UPDATE medicine_market_cards SET data=jsonb_build_object('image',$1::text) WHERE id=3", [privateImage.url]);
    assert.equal((await fetch(`${root}/cards/3/image-variants/icon`)).status, 404);
    const allowed = await fetch(`${root}/cards/3/image-variants/icon`, { headers: { "x-test-user": "owner" } });
    assert.equal(allowed.status, 200); assert.match(allowed.headers.get("cache-control") ?? "", /no-store/);
    const privateId = privateImage.url.split("/").at(-1);
    await pool.query("DELETE FROM market_image_uploads WHERE id=$1", [privateId]);
    assert.equal(Number((await pool.query("SELECT count(*) FROM market_image_variants WHERE image_id=$1", [privateId])).rows[0].count), 0);
    assert.equal((await fetch(`${root}/image-variants/status`)).status, 403);
    assert.equal((await fetch(`${root}/image-variants/status`, { headers: { "x-test-user": "owner" } })).status, 200);
    assert.equal((await pool.query("SELECT revision FROM medicine_market_cards WHERE id=4")).rows[0].revision, 1);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

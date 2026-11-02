import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { createMarketDatabase } from "../apps/api/src/market/database.ts";
import { marketTypes } from "../packages/contracts/src/medicine-market.ts";

const connection = process.env.MARKET_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test("separate market migrations seed pharmacies and nested geographic references", async t => {
  if (!connection) return t.skip("A disposable PostgreSQL database is required");
  const schema = "market_seed_" + randomUUID().replaceAll("-","");
  const db = await createMarketDatabase(connection,schema);
  t.after(async () => {
    await db.end();
    const admin = new Pool({connectionString:connection});
    try {await admin.query('DROP SCHEMA "' + schema + '" CASCADE');}
    finally {await admin.end();}
  });
  const countType = async (kind:string) => Number((await db.query("SELECT count(*)::int n FROM market_reference_entries WHERE kind=$1",[kind])).rows[0].n);
  assert.ok(await countType("country") >= 12);
  assert.equal(await countType("governorate"),22);
  assert.ok(await countType("city") >= 20);
  assert.equal(Number((await db.query("SELECT count(*)::int n FROM medicine_market_cards WHERE kind='pharmacy'")).rows[0].n),70);
  const r = await db.query("SELECT name,data FROM medicine_market_cards WHERE name IN ($1,$2,$3)",[
    "صيدلية أبو رامي","صيدليات عصام المركزية — فرع الأصبخي","صيدليات ابن حيان — فرع حدة المدينة",
  ]);
  const records = new Map<string, Record<string,unknown>>(r.rows.map(z=>[z.name,z.data]));
  assert.equal(records.get("صيدلية أبو رامي")?.landlinePhone,"01371007");
  assert.equal(records.get("صيدلية أبو رامي")?.phone,undefined);
  assert.equal(records.get("صيدليات عصام المركزية — فرع الأصبخي")?.landlinePhone,"01677780");
  assert.equal(records.get("صيدليات عصام المركزية — فرع الأصبخي")?.phone,"782266996");
  assert.equal(records.get("صيدليات ابن حيان — فرع حدة المدينة")?.landlinePhone,undefined,
    "Do not truncate the nine-digit 014322238 into an eight-digit number");
  const bad = await db.query("SELECT name FROM medicine_market_cards WHERE kind='pharmacy' AND (data ? 'contacts' OR (data ? 'phone' AND (data->>'phone' !~ '^7[0-9]{8}$')) OR (data ? 'landlinePhone' AND (data->>'landlinePhone' !~ '^0[0-9]{7}$')))");
  assert.deepEqual(bad.rows,[]);
  const count = Number((await db.query("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n);
  await db.query(readFileSync("apps/api/market-migrations/003_seed_pharmacies_2026.sql","utf8"));
  assert.equal(Number((await db.query("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n),count,
    "re-running the import must not duplicate records");
});

test("pharmacy and wholesale fields have one mobile and one landline",()=>{
  for (const kind of ["pharmacy","wholesaler"] as const) {
    const type = marketTypes.find(x=>x.key===kind)!;
    assert.equal(type.fields.find(x=>x.key==="phone")?.type,"mobile-phone");
    assert.equal(type.fields.find(x=>x.key==="landlinePhone")?.type,"landline-phone");
    assert.equal(type.fields.some(x=>x.key==="contacts"),false);
    assert.equal(type.fields.find(x=>x.key==="governorateCode")?.type,"reference");
  }
  const code = readFileSync("apps/api/src/routes-medicine-market.ts","utf8");
  assert.ok(code.includes("^0[0-9]{7}$"));
  assert.ok(code.includes("^7[0-9]{8}$"));
  const ui = readFileSync("apps/web/src/pages/MedicineMarketPage.tsx","utf8");
  assert.match(ui,/المحافظات والمدن/);
  assert.match(ui,/fixed-dosage-forms/);
  assert.match(ui,/field\.type === "landline-phone" \? 8/);
});

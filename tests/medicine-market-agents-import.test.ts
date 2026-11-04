import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createMarketDatabase } from "../apps/api/src/market/database.ts";

const connection=process.env.MARKET_TEST_DATABASE_URL;

test("agent import strips cash suffixes, deduplicates agents and preserves distinct divisions", {skip:!connection}, async()=>{
  const schema="market_agents_"+randomUUID().replaceAll("-","");
  const db=await createMarketDatabase(connection!,schema);
  try {
    const total=Number((await db.query("SELECT count(*)::int n FROM medicine_market_cards WHERE kind='agent'")).rows[0].n);
    assert.equal(total,583);
    const types=await db.query("SELECT kind,count(*)::int AS n FROM medicine_market_cards GROUP BY kind ORDER BY kind");
    assert.deepEqual(types.rows,[{kind:"agent",n:583},{kind:"pharmacy",n:70}]);
    const named=await db.query("SELECT name FROM medicine_market_cards WHERE kind='agent'");
    const names=new Set<string>(named.rows.map(x=>x.name));
    for(const yes of ["مركز الربيعي","مؤسسة العواضي","هران فارما","شركة الشرق للتجارة ادوية","سمارت فارما","المدار فارما","محلات الخليل","شركه جلف كير لاستيراد الادويه","أراك كيور للادوية والمستلزمات الطبية","شركة ريمان فارما - فرع صنعاء","شركة ريمان فارما - التخصصية فرع صنعاء"]) {
      assert.ok(names.has(yes), "Expected canonical agent "+yes);
    }
    for(const no of ["مركز الربيعي - الحساب النقدي","هران فارما - نقدي","شركة الشرق للتجارة ادوية - نقدا","سمارت فارما - نقدي","بعوم سوطيما","شركة جلف كير","وسام اليمن","اراك كيور","مستشفى جامعة العلوم والتكتولوجيا"]) {
      assert.ok(!names.has(no), "Cash alias or typo should not create a second card: "+no);
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM medicine_market_cards WHERE kind='agent' AND name ~ '(نقدي|نقدا|النقدي)$'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM (SELECT normalized_name FROM medicine_market_cards WHERE kind='agent' GROUP BY normalized_name HAVING count(*)>1) d")).rows[0].n,0);
    await db.query(readFileSync("apps/api/market-migrations/004_seed_agents_2026.sql","utf8"));
    assert.equal((await db.query("SELECT count(*)::int n FROM medicine_market_cards WHERE kind='agent'")).rows[0].n,583,
      "Repeated import must be idempotent");
    assert.equal((await db.query("SELECT count(*)::int n FROM market_schema_migrations")).rows[0].n,5);
  }finally{
    await db.end();
    const admin=new Pool({connectionString:connection});
    try{await admin.query('DROP SCHEMA "'+schema+'" CASCADE');}
    finally{await admin.end();}
  }
});

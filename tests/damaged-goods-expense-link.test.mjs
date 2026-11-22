import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("damaged goods link expands existing purposes without changing any tenant link", async () => {
  const sql = await readFile(new URL("../apps/api/migrations/20261122_damaged_goods_expense_link.sql", import.meta.url), "utf8");
  const contract = await readFile(new URL("../packages/contracts/src/masters.ts", import.meta.url), "utf8");
  const enumValues = contract.match(/accountLinkPurposes = \[([\s\S]+?)\] as const/)[1].match(/"[^"]+"/g).map(x => x.slice(1, -1));
  const checkValues = Array.from(sql.matchAll(/'([A-Za-z]+)'/g), m => m[1]);
  assert.deepEqual([...new Set(checkValues)].sort(), [...enumValues].sort());
  assert.match(contract, /damagedGoodsExpense: "بضاعة تالفة"/);
  assert.match(contract, /damagedGoodsExpense: "expense"/);
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE account_links(
      company_id integer, purpose text CONSTRAINT account_links_purpose_check CHECK(purpose IN (${checkValues.filter(x => x !== "damagedGoodsExpense").map(x => "'" + x + "'").join(",")})),
      account_id integer, PRIMARY KEY (company_id,purpose));
      INSERT INTO account_links VALUES(2,'stockShortage',35),(3,'stockShortage',36);`);
    await pg.exec(sql);
    assert.equal((await pg.query("SELECT * FROM account_links WHERE purpose='damagedGoodsExpense'")).rowCount, 0);
    await pg.query("INSERT INTO account_links VALUES($1,$2,$3) ON CONFLICT(company_id,purpose) DO UPDATE SET account_id=excluded.account_id", [2,"damagedGoodsExpense",118]);
    assert.deepEqual((await pg.query("SELECT * FROM account_links ORDER BY company_id,purpose")).rows, [
      {company_id:2,purpose:"damagedGoodsExpense",account_id:118},
      {company_id:2,purpose:"stockShortage",account_id:35},
      {company_id:3,purpose:"stockShortage",account_id:36},
    ]);
    await assert.rejects(pg.query("INSERT INTO account_links VALUES(2,'unsupported',118)"), {code:"23514"});
  } finally {
    await pg.close();
  }
});

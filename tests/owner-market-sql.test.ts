import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "../apps/api/src/routes-owner-sql.ts";

test("owner SQL parser differentiates isolated market schema from public schema",()=>{
  const market=inspect("UPDATE market.medicine_market_cards SET name='X' WHERE id=1","market");
  assert.equal(market.kind,"update");
  assert.equal(market.table,"medicine_market_cards");
  assert.throws(()=>inspect("UPDATE public.users SET name='X' WHERE id=1","market"));
  assert.throws(()=>inspect("DELETE FROM market.audit_events WHERE id=1","market"));
  assert.throws(()=>inspect("UPDATE medicine_market_cards SET name='X'","market"));
  assert.equal(inspect("SELECT id, name FROM medicine_market_cards","market").kind,"select");
});
test("market SQL queries use signed private service and are never available over MCP SQL",()=>{
  const main=readFileSync("apps/api/src/routes-owner-sql.ts","utf8");
  const privateService=readFileSync("apps/api/src/market/app.ts","utf8");
  const ownerMarket=readFileSync("apps/api/src/market/owner-sql.ts","utf8");
  const catalog=readFileSync("apps/api/src/mcp-contracts.json","utf8");
  assert.match(main,/signMarketRequest/);
  assert.match(main,/preview\.database!==input\.database/);
  assert.match(main,/askMarket\(marketOptions,"preview"/);
  assert.match(main,/askMarket\(marketOptions,"execute"/);
  assert.match(privateService,/ownerMarketSqlRoutes\(pool\)/);
  assert.match(ownerMarket,/ownerOnly\(user\)/);
  assert.match(ownerMarket,/audit\(client,user,"owner\.sql\.execute","medicine-market"/);
  assert.doesNotMatch(catalog, /"POST \/owner-sql\/(preview|execute)"/);
  assert.doesNotMatch(catalog, /"POST \/internal\/owner-sql-market\/(preview|execute)"/);
});

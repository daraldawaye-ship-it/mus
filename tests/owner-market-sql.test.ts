import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "../apps/api/src/routes-owner-sql.ts";
const read=(path:string)=>readFileSync(path,"utf8");

test("owner SQL parser differentiates market schema from main and protects special tables",()=>{
  const market=inspect("UPDATE market.medicine_market_cards SET name='X' WHERE id=1","market");
  assert.equal(market.kind,"update");
  assert.equal(market.table,"medicine_market_cards");
  assert.throws(()=>inspect("UPDATE public.users SET name='X' WHERE id=1","market"));
  assert.throws(()=>inspect("DELETE FROM market.audit_events WHERE id=1","market"));
  assert.throws(()=>inspect("UPDATE medicine_market_cards SET name='X'","market"));
  assert.equal(inspect("SELECT id, name FROM medicine_market_cards","market").kind,"select");
});
test("website SQL is SELECT only, with server-side rejection of writes",()=>{
  const main=read("apps/api/src/routes-owner-sql.ts");
  const ui=read("apps/web/src/pages/OwnerSqlConsolePage.tsx");
  assert.match(main,/if\(statement\.kind!=="select"\)/);
  assert.match(main,/sql_chatgpt_only/);
  assert.match(main,/router\.post\("\/owner-sql\/execute"/);
  assert.match(ui,/SQL — للقراءة فقط/);
  assert.doesNotMatch(ui,/api<Written>|\/owner-sql\/execute/);
  assert.match(ui,/السوق الرئيسي/);
});
test("market SQL uses signed private service, and OAuth MCP owns mutation preview/execution",()=>{
  const main=read("apps/api/src/routes-owner-sql.ts");
  const market=read("apps/api/src/market/owner-sql.ts");
  const app=read("apps/api/src/market/app.ts");
  const mcp=read("apps/api/src/routes-chatgpt-mcp.ts");
  const sqlMcp=read("apps/api/src/services/owner-sql-mcp.ts");
  const catalog=read("apps/api/src/mcp-contracts.json");
  assert.match(main,/signMarketRequest/);
  assert.match(main,/export async function askMarket/);
  assert.match(app,/ownerMarketSqlRoutes\(pool\)/);
  assert.match(market,/ownerOnly\(user\)/);
  assert.match(market,/audit\(client,user,"owner\.sql\.execute","medicine-market"/);
  assert.match(mcp,/ownerSqlMcpTools/);
  assert.match(mcp,/callOwnerSqlMcp/);
  assert.match(sqlMcp,/name:"preview_bulk_sql"/);
  assert.match(sqlMcp,/name:"execute_bulk_sql"/);
  assert.match(sqlMcp,/preview\.?/); // preview confirmation is held server-side
  assert.match(sqlMcp,/pending\.delete\(input\.previewId\)/);
  assert.match(sqlMcp,/user\.owner/);
  assert.doesNotMatch(catalog, /"POST \/owner-sql\/(preview|execute)"/);
  assert.doesNotMatch(catalog, /"POST \/internal\/owner-sql-market\/(preview|execute)"/);
});

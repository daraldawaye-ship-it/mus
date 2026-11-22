import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import type {Request} from "express";
import type {PoolClient} from "pg";
import {readAccountLedger} from "../apps/api/src/routes-finance.ts";
import {accountLedgerStartLimit,applyAccountLedgerStartLimit,DAR_ALDAWA_STAFF_LEDGER_START as limit} from "../packages/contracts/src/account-ledger-date-policy.ts";

test("Dar Aldawa staff cannot select an empty, earlier or invalid start; owner and other companies are unchanged",()=>{
  assert.equal(accountLedgerStartLimit(2,false),limit);
  for(const raw of [null,"","2026-10-31","2026-11-31","malformed"])
    assert.equal(applyAccountLedgerStartLimit(raw,limit),"2026-11-01");
  assert.equal(applyAccountLedgerStartLimit("2026-11-01",limit),limit);
  assert.equal(applyAccountLedgerStartLimit("2026-11-04",limit),"2026-11-04");
  for(const min of [accountLedgerStartLimit(2,true),accountLedgerStartLimit(3,false)]){
    assert.equal(applyAccountLedgerStartLimit(null,min),null);
    assert.equal(applyAccountLedgerStartLimit("",min),"");
    assert.equal(applyAccountLedgerStartLimit("2026-10-31",min),"2026-10-31");
  }
});

function fakeLedger() {
  const replies=[[{id:12,code:"12",name:"fixture"}],[{balance:"90"}],[{debit:"12",credit:"2"}],[{total:0}],[],[{code:"YER"}]];
  const reads:{sql:string;params:unknown[]}[]=[];
  const client={query:async(sql:string,params:unknown[])=>{
    const rows=replies[reads.length];
    reads.push({sql,params});
    return {rows,rowCount:rows.length};
  }} as unknown as PoolClient;
  return {client,reads};
}

test("server sends the bounded date to opening balance, totals, counts and rows even on direct or print requests",async()=>{
  for(const [query,expected] of [[{},limit],[{dateFrom:""},limit],[{dateFrom:"2026-10-31"},limit],[{dateFrom:"2026-11-03",pageSize:"100"},"2026-11-03"]] as const){
    const {client,reads}=fakeLedger();
    const result=await readAccountLedger(client,2,12,{query} as unknown as Request,"account",accountLedgerStartLimit(2,false));
    assert.deepEqual(reads.slice(1,5).map(x=>x.params[2]),Array(4).fill(expected));
    assert.match(reads[4].sql,/f\.document_date >= \$3::date/);
    assert.equal(Number(result.totals.openingBalance),90);
    assert.equal(Number(result.totals.closingBalance),100);
  }
});

test("an end date before the staff cutoff cannot expose older rows",async()=>{
  const {client,reads}=fakeLedger();
  await assert.rejects(readAccountLedger(client,2,12,{query:{dateFrom:"",dateTo:"2026-10-31"}} as unknown as Request,"account",limit),
    {message:"بداية الفترة تتجاوز نهايتها"});
  assert.equal(reads.length,1);
});

test("regular route derives the cutoff from the fresh actor; full view and work panel both require From",()=>{
  const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8");
  const server=read("../apps/api/src/routes-finance.ts");
  assert.match(server,/const user = await currentActor[\s\S]*return action\(client, companyId, user\)/);
  assert.match(server,/accountLedgerStartLimit\(companyId,user.owner\)/);
  for(const path of ["FinancePages","AccountsPage"]){
    const ui=read("../apps/web/src/pages/"+path+".tsx");
    assert.match(ui,/accountLedgerStartLimit\(companyId,!!user\?\.owner\)/);
    assert.match(ui,/min=\{startLimit\}\s+required=\{!!startLimit\}/);
  }
});

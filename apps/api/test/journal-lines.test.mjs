import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {PGlite} from "@electric-sql/pglite";

const read = (path)=>readFile(new URL(path,import.meta.url),"utf8");
const routes=await read("../src/routes-finance.ts");
const permissions=await read("../src/services/permission-rules.ts");
const contract=await read("../../../packages/contracts/src/pages.ts");
const start=routes.indexOf("  router.get(\n    `${base}/journal-lines`,");
const end=routes.indexOf("  router.get(",start+10);
const javascript=ts.transpileModule(routes.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;

test("actual journal-lines SQL paginates both lines, using the document date and company scope", async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE financial_documents(id int, company_id int, number text, kind text, status text, document_date date, description text, currency_id int, currency_code text, posted_at timestamptz);
      CREATE TABLE financial_document_lines(id int,company_id int,document_id int,line_number int,account_id int,account_code text,account_name text,debit numeric,credit numeric,description text);
      CREATE TABLE accounts(company_id int,id int,code text,name text);
      CREATE TABLE company_currencies(company_id int,id int,code text);
      CREATE TABLE purchase_correction_journal_dates(company_id int,document_id int,invoice_date date);
      INSERT INTO financial_documents VALUES
        (25,2,'0000000025','journal','posted','2026-11-21','journal header',1,null,'2026-11-22T08:19:42.125Z'),
        (25,3,'0000000025','journal','posted','2026-11-21','other company',1,null,'2026-11-22T08:19:42Z'),
        (26,2,'0000000026','receipt','posted','2026-11-21','not a journal',1,null,'2026-11-22T08:19:42Z'),
        (27,2,'0000000027','journal','draft','2026-11-21','draft header',1,null,null);
      INSERT INTO purchase_correction_journal_dates VALUES (2,25,'2026-10-01');
      INSERT INTO accounts VALUES(2,1,'100','current name'),(2,2,'200','إيراد المبيعات'),(3,1,'999','other company');
      INSERT INTO company_currencies VALUES(2,1,'YER'),(3,1,'XXX');
      INSERT INTO financial_document_lines VALUES
        (10,2,25,1,1,'100','صندوق مبيعات – أسامة زيد',5,0,'debit explanation'),
        (11,2,25,2,2,null,null,0,5,'credit explanation'),
        (12,3,25,1,1,null,null,0,10,'other company'),
        (13,2,26,1,1,null,null,0,11,'receipt only'),
        (14,2,27,1,1,null,null,2,0,'draft only');
    `);
    let serve;
    new Function("router","base","handler","pool","readFinance","listQuery","dateFilters","searchPattern","parse","z","documentStatuses",javascript)(
      {get:(path,callback)=>{assert.equal(path,"/companies/:companyId/journal-lines");serve=callback;}},
      "/companies/:companyId", callback=>callback, db,
      async(pool,req,callback)=>callback(pool,req.companyId),
      req=>({q:req.q??"",page:req.page??1,pageSize:req.pageSize??1,offset:(req.page??1)-1,
        order:"d.document_date DESC,d.number DESC,l.id ASC"}),
      req=>({from:req.query.dateFrom,to:req.query.dateTo}),q=>`%${q}%`, (_,v)=>v,
      {enum:()=>null},["posted","draft","reversed"],
    );
    const run=async(query)=>{
      let result;
      await serve({query,companyId:2},{set:()=>{},json:x=>result=x});
      return result;
    };
    const x=await run({status:"posted",dateFrom:"2026-11-21",page:1});
    assert.deepEqual(x,{items:[{id:10,documentId:25,lineNumber:1,number:"0000000025",documentDate:"2026-11-21",postedAt:"2026-11-22T08:19:42.125Z",documentDescription:"journal header",status:"posted",accountId:1,
      accountCode:"100",accountName:"صندوق مبيعات – أسامة زيد",debit:"5",credit:"0",currencyCode:"YER",description:"debit explanation"}],total:2,page:1,pageSize:1});
    assert.equal((await run({status:"posted",page:2})).items[0].accountName,"إيراد المبيعات");
    assert.equal((await run({status:"posted",dateTo:"2026-10-01"})).total,0);
    assert.equal((await run({q:"إيراد"})).total,1);
    assert.equal((await run({})).total,3);
    const draft=(await run({status:"draft"})).items[0];
    assert.equal(draft.postedAt,null);
    assert.equal(draft.documentDescription,"draft header");
    assert.equal(draft.description,"draft only");
  } finally { await db.close(); }
});

test("journal lines use existing finance access plus journal page and report scopes",()=>{
  assert.match(javascript,/postedAt: "d\.posted_at"[\s\S]*new Set\(\["postedAt"\]\)/);
  assert.match(javascript,/readFinance\(pool, req/);
  assert.match(permissions,/resource === "journal-lines" && action === "view"[\s\S]*?pagePermissionAliases\("company\.journals", "view"\)[\s\S]*?pagePermissionAliases\("company\.journal-lines", "view"\)/);
  assert.match(contract,/"company\.journal-lines",[\s\S]*?\{ view: financial\.view \},[\s\S]*?parentKey: "company\.journals"/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { dailyInvoiceLineRoutes, dailyInvoiceLinesSql } from "../apps/api/src/routes-daily-invoice-lines.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";

test("daily line counts preserve mixed docs, repaired sale sign, active purchase reporting dates, and separated staging", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE TABLE invoices(company_id int,id int,kind text,document_date date,posted boolean);
      CREATE TABLE invoice_lines(company_id int,invoice_id int,line_number int,smallest_quantity bigint);
      CREATE TABLE legacy_sales_sign_repairs(company_id int,invoice_id int,line_snapshots jsonb);
      CREATE TABLE purchase_correction_dates(company_id int,invoice_id int,invoice_date date);
      CREATE TABLE purchase_invoice_corrections(company_id int,original_id int,reversal_id int);
      CREATE TABLE staged_item_daily_activity_cache(company_id int,document_date date,sale_lines bigint,
        sale_return_lines bigint,purchase_lines bigint,purchase_return_lines bigint);
      INSERT INTO invoices VALUES
      (2,1,'sale','2026-01-01',true),(2,2,'sale','2026-01-01',true),(2,3,'sale','2026-01-01',false),
      (2,4,'purchase','2026-01-01',true),(2,5,'purchase','2026-01-03',true),
      (2,6,'purchase','2026-12-01',true),(1,1,'sale','2026-01-01',true),
      (2,7,'purchase','2026-01-03',true),(2,8,'purchase','2026-01-03',true);
      INSERT INTO invoice_lines VALUES
      (2,1,1,200),(2,1,2,-1),(2,1,3,0),(2,2,1,2),(2,2,2,3),(2,3,1,4),
      (2,4,1,5),(2,5,1,-5),(2,6,1,7),(1,1,1,-9),(2,7,1,-1),(2,8,1,25);
      INSERT INTO legacy_sales_sign_repairs VALUES (2,2,'[{"lineNumber":1,"smallestQuantity":"-2"}]');
      INSERT INTO purchase_invoice_corrections VALUES (2,4,5);
      INSERT INTO purchase_correction_dates VALUES (2,5,'2026-01-01'),(2,6,'2026-01-01');
      INSERT INTO staged_item_daily_activity_cache VALUES (2,'2026-01-01',3,4,5,6),(2,'2026-01-01',1,2,0,0),
        (1,'2026-01-01',9,9,9,9);
    `);
    const count = (sales: number,salesReturns: number,purchases: number,purchaseReturns: number) =>
      ({sales,salesReturns,purchases,purchaseReturns});
    const q = await db.query(dailyInvoiceLinesSql,[2,"2026-01-01","2026-01-03",true]);
    assert.deepEqual(q.rows,[
      {date:"2026-01-03",posted:count(0,0,1,1),staged:count(0,0,0,0),rawPosted:count(0,0,1,2)},
      {date:"2026-01-02",posted:count(0,0,0,0),staged:count(0,0,0,0),rawPosted:count(0,0,0,0)},
      {date:"2026-01-01",posted:count(2,2,1,0),staged:count(4,6,5,6),rawPosted:count(3,1,1,0)},
    ]);
    const noRaw = await db.query<{rawPosted: unknown}>(dailyInvoiceLinesSql,[2,"2026-01-01","2026-01-01",false]);
    assert.equal(noRaw.rows[0].rawPosted,null);
    assert.deepEqual(apiCatalog(dailyInvoiceLineRoutes({} as Pool),{operation:"GET /companies/:companyId/daily-invoice-line-counts"}).operations,
      [{operation:"GET /companies/:companyId/daily-invoice-line-counts",tool:"tijara_api_read",
        source:"routes-daily-invoice-lines.ts",pathParams:["companyId"],queryFields:["dateFrom","dateTo","includeRaw"]}]);
  } finally { await db.close(); }
});

test("daily line count route denies non-owners and rejects long ranges before database access", async () => {
  const {default: express} = await import("express");
  const app = express();
  app.use((req, _res, next) => {
    req.auth = {user:{id:1,owner:req.header("x-test-owner")==="yes"} as NonNullable<typeof req.auth>["user"],tokenHash:"",csrf:""};
    next();
  });
  app.use(dailyInvoiceLineRoutes({
    connect:async () => { throw new Error("Invalid or unauthorized request unexpectedly opened a database connection"); },
  } as unknown as Pool));
  app.use((error:{status?:number}, _req:import("express").Request,
    res:import("express").Response, _next:import("express").NextFunction) => {
    res.status(error.status ?? 500).json({});
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const address = server.address() as {port:number};
    const path = "http://127.0.0.1:"+address.port+"/companies/2/daily-invoice-line-counts";
    assert.equal((await fetch(path+"?dateFrom=2026-01-01&dateTo=2026-11-21")).status,403);
    assert.equal((await fetch(path+"?dateFrom=2026-01-01&dateTo=2027-01-02",{headers:{"x-test-owner":"yes"}})).status,400);
  } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
});

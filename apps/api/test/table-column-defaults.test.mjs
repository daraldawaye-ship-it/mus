import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import {
  tableColumnDefaultIds, tableColumnDefaultsCatalog, tableColumnDefaultsInputSchema,
  tableColumnDefaultsResponseSchema, usableColumnDefaults,
} from "../../../packages/contracts/src/table-column-defaults.ts";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../src/routes-table-column-defaults.ts");
const migration = await read("../migrations/20261122_zzzz_table_column_defaults.sql");
const compile = (source) => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText.replace(/^export /gm,"");
const deps = { tableColumnDefaultIds, tableColumnDefaultsCatalog, tableColumnDefaultsInputSchema,
  tableColumnDefaultsResponseSchema, usableColumnDefaults, parse: (schema, value) => schema.parse(value),
  HttpError: class extends Error { constructor(status,code,message) { super(message); this.status=status; this.code=code; } } };
const api = new Function(...Object.keys(deps),
  compile(source.slice(source.indexOf("type ColumnScope"), source.indexOf("export function tableColumnDefaultsRoutes"))) +
  "\nreturn {readTableColumnDefaults,saveTableColumnDefaults};"
)(...Object.values(deps));

test("company and table isolation, first-write/CAS conflicts, ordered validated values and empty reset", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE companies(id integer PRIMARY KEY); CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO companies VALUES (2),(3); INSERT INTO users VALUES(42);");
    await db.exec(migration);
    const scope = {companyId:2,tableId:"journal-lines"};
    const otherCompany = {...scope,companyId:3};
    const otherTable = {...scope,tableId:"item-options-list"};
    const c = {id:"debit",width:100,visible:false,color:"#AABBCC"};
    const c2 = {id:"number",width:90,visible:true,color:null};
    assert.deepEqual(await api.readTableColumnDefaults(db,scope),{revision:0,columns:[]});
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:1,columns:[c]}),{status:409});
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:[c,c]}));
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:
      tableColumnDefaultsCatalog["journal-lines"].columnIds.map(id=>({...c,id}))}),{code:"table_columns_all_hidden"});
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:[{...c,id:"stock"}]}),{status:400});
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:[{...c,color:"javascript:alert(1)"}]}));
    assert.deepEqual(await api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:[c,c2]}),
      {revision:1,columns:[{...c,color:"#aabbcc"},c2]});
    await assert.rejects(api.saveTableColumnDefaults(db,scope,42,{expectedRevision:0,columns:[c2]}),{status:409});
    assert.deepEqual(await api.readTableColumnDefaults(db,otherCompany),{revision:0,columns:[]});
    assert.deepEqual(await api.readTableColumnDefaults(db,otherTable),{revision:0,columns:[]});
    await db.query("UPDATE company_table_column_defaults SET columns_json=columns_json || $1::jsonb",
      [JSON.stringify([{...c,id:"removedColumn"}])]);
    assert.equal((await api.readTableColumnDefaults(db,scope)).columns.length,2);
    assert.deepEqual(await api.saveTableColumnDefaults(db,scope,42,{expectedRevision:1,columns:[]}),{revision:2,columns:[]});
  } finally { await db.close(); }
});

test("actual route rejects unauthorized access before loading/writing, gates exact companies and pages", async () => {
  const routes = {};
  const deps = { Router:()=>({get:(_,cb)=>routes.get=cb,put:(_,cb)=>routes.put=cb}),
    handler:cb=>cb, actor:req=>{if (!req.auth)throw Object.assign(new Error(),{status:401});return req.auth;},
    readScope:(id,tableId)=>({companyId:Number(id),tableId}),
    tableColumnDefaultsCatalog,
    transaction:async(db,cb)=>cb(db), currentActor:async(_db,user)=>user,
    companyAccess:async(_db,u,id,permission)=>{if ((id!==2 && !u.owner)|| !["finance.view","items.view"].includes(permission))throw Object.assign(new Error(),{status:403});},
    ownerOnly:u=>{if(!u.owner)throw Object.assign(new Error(),{status:403});},
    assertRequestPagesEnabled:async(_db,req)=> {
      if (req.auth.denied) throw Object.assign(new Error(),{status:403});
    },
    assertItemOptionsListReadAccess:async(_db,u)=> {
      if (u.coverageDenied) throw Object.assign(new Error(),{status:403});
    },
    directoryEntries:async(_db,u)=>[
      {key:"company.table-column-defaults",view:!u.settingsDisabled,edit:!u.settingsEditDenied},
      {key:"company.journal-lines",view:true},
    ],
    assertDirectoryAccess:(entry,action)=>{
      if (!entry.view || !entry[action]) throw Object.assign(new Error(),{status:403});
    },
    readTableColumnDefaults:async()=>{reads++;return {revision:0,columns:[]};},
    saveTableColumnDefaults:async()=>{writes++;return {revision:1,columns:[]};}, audit:async()=>{},
  };
  let reads=0,writes=0;
  new Function(...Object.keys(deps),compile(source.slice(source.indexOf("export function tableColumnDefaultsRoutes")))+"\nreturn tableColumnDefaultsRoutes;")(
    ...Object.values(deps))({query:async()=>{}});
  const req=(auth,companyId="2",tableId="journal-lines")=>({auth,params:{companyId,tableId}});
  const res={set:(name,value)=>{assert.equal(name,"Cache-Control");assert.equal(value,"private, no-store");return res;},json:value=>value};
  await assert.rejects(routes.get(req(null),res),{status:401});
  await assert.rejects(routes.get(req({owner:false},"3"),res),{status:403});
  await assert.rejects(routes.get(req({owner:false,denied:true}),res),{status:403});
  await assert.rejects(routes.put(req({owner:false}),res),{status:403});
  await assert.rejects(routes.put(req({owner:true,settingsDisabled:true}),res),{status:403});
  await assert.rejects(routes.put(req({owner:true,settingsEditDenied:true}),res),{status:403});
  await assert.rejects(routes.get(req({owner:false,coverageDenied:true},"2","item-options-list"),res),{status:403});
  assert.deepEqual([reads,writes],[0,0]);
  await routes.get(req({owner:false}),res);
  await routes.put(req({owner:true,id:42}),res);
  assert.deepEqual([reads,writes],[1,1]);
});

test("shared native item gate checks each required page and the coverage permission", async () => {
  const report = await read("../src/routes-item-options-list.ts");
  const body = report.slice(report.indexOf("export async function assertItemOptionsListReadAccess"),
    report.indexOf("async function filteredItems"));
  const keys = ["company.item-options-list","company.items","company.sales","company.purchases",
    "company.invoice","company.stock-balances","company.stock-movements"];
  const gate = new Function("directoryEntries","canReadItemCoverage","HttpError",
    compile(body)+"\nreturn assertItemOptionsListReadAccess;")(
      async(_db,u)=>keys.map(key=>({key,enabled:key!==u.disabled,actionAccess:{view:key!==u.denied}})),
      async(_db,u)=>!u.coverageDenied,deps.HttpError);
  for (const key of keys) {
    await assert.rejects(gate({}, {disabled:key},2),{code:"item_filter_denied"});
    await assert.rejects(gate({}, {denied:key},2),{code:"item_filter_denied"});
  }
  await assert.rejects(gate({}, {coverageDenied:true},2),{code:"item_filter_denied"});
  await gate({}, {},2);
  assert.match(report, /async function filteredItems[^]*?await assertItemOptionsListReadAccess\(client, user, companyId\)/);
});

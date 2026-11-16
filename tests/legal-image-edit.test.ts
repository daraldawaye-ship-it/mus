import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { legalCaseRoutes, mcpBodySchemas } from "../apps/api/src/routes-legal-cases.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { HttpError } from "../apps/api/src/errors.ts";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG9sAAAAASUVORK5CYII=","base64");
const replacement=Buffer.concat([png,Buffer.from("replacement")]);
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const dataUrl=(bytes:Uint8Array,mime="image/png")=>`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("legal image catalog publishes the registered metadata, replacement and deletion contracts",()=>{
  const router=legalCaseRoutes({} as Pool);
  const get=apiCatalog(router,{operation:"GET /legal/records/:id/images/:imageId/metadata"}).operations[0];
  assert.deepEqual(get.pathParams,["id","imageId"]);
  assert.equal(get.tool,"tijara_api_read");
  for(const [method,schema] of [["PUT",mcpBodySchemas.legalRecordImageReplaceSchema],["DELETE",mcpBodySchemas.legalImageMatchSchema]] as const){
    const operation=`${method} /legal/records/:id/images/:imageId`;
    const contract=apiCatalog(router,{operation}).operations[0];
    assert.equal(contract.tool,"tijara_api_write");
    assert.deepEqual(contract.pathParams,["id","imageId"]);
    assert.deepEqual(contract.bodySchema,z.toJSONSchema(schema));
    assert.ok(contract.bodySchema.required.includes("expectedSha256"));
    assert.equal(schema.safeParse({}).success,false);
  }
});

test("legal image edits enforce all-case access, byte comparison and metadata-only auditing",async t=>{
  const db=new PGlite();
  await db.exec(`
    CREATE TABLE users(id integer PRIMARY KEY,name text,display_name text,email text,phone text,image text,kind text,
      owner boolean DEFAULT false,archived boolean DEFAULT false,suspended boolean DEFAULT false,editor boolean DEFAULT false,
      monitor boolean DEFAULT false,created_at timestamptz DEFAULT now());
    INSERT INTO users(id,name,display_name,kind,owner) VALUES
      (1,'Owner','Owner','admin',true),(2,'Editor','Editor','member',false),
      (3,'Viewer','Viewer','member',false),(4,'Reporter','Reporter','member',false),(5,'Other','Other','member',false);
    CREATE TABLE legal_cases(id integer PRIMARY KEY,title text);
    INSERT INTO legal_cases VALUES(1,'Visible'),(2,'Private');
    CREATE TABLE legal_case_access(case_id integer,user_id integer,role text);
    INSERT INTO legal_case_access VALUES(1,2,'editor'),(1,3,'viewer'),(1,4,'reporter');
    CREATE TABLE legal_records(id integer PRIMARY KEY,kind text,title text,body text,content_text text,
      revision integer DEFAULT 7,drive_file_id text DEFAULT 'original-drive',legacy_snapshot jsonb DEFAULT '{"kept":true}');
    INSERT INTO legal_records(id,kind,title,body,content_text) VALUES
      (10,'document','Original','Keep body','Keep text'),(20,'document','Private','Keep private','Keep private text'),
      (30,'fact','Not a document','Keep fact',''),(40,'document','Shared','Keep shared',''),(50,'document','Owner only','Keep orphan','');
    CREATE TABLE legal_record_cases(record_id integer,case_id integer);
    INSERT INTO legal_record_cases VALUES(10,1),(20,2),(30,1),(40,1),(40,2);
    CREATE TABLE legal_document_images(id integer PRIMARY KEY,record_id integer,mime_type text,image_bytes bytea,
      filename text,uploaded_by integer,created_at timestamptz DEFAULT now());
    CREATE TABLE page_settings(page_key text,company_id integer,enabled boolean);
    CREATE TABLE audit_events(id serial PRIMARY KEY,actor_id integer,actor_name text,scope text,company_id integer,
      action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
  `);
  for(const [id,recordId] of [[100,10],[101,10],[200,20],[300,30],[400,40],[500,50]])
    await db.query("INSERT INTO legal_document_images(id,record_id,mime_type,image_bytes,filename,uploaded_by) VALUES($1,$2,'image/png',$3,'original.png',1)",[id,recordId,png]);
  let intervene:"UPDATE"|"DELETE"|null=null;
  const query=async(sql:string,params:unknown[]=[])=>{
    if(intervene && sql.startsWith(`${intervene} ${intervene==="DELETE"?"FROM ":""}legal_document_images`)){
      intervene=null;
      // Change the row after the handler's read/hash check, before its conditional write.
      // The isolated SQL engine must reject the original-byte predicate, even with a matching expected hash.
      await db.query("UPDATE legal_document_images SET image_bytes=$1 WHERE id=100",[replacement]);
    }
    const result=await db.query(sql,params);
    return {...result,rowCount:/^\s*SELECT\b/i.test(sql)?result.rows.length:result.affectedRows};
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const app=express();app.use(express.json({limit:"4mb"}));
  app.use((req,_res,next)=>{
    const id=Number(req.get("x-test-user")??1);
    req.auth={user:{id,displayName:`Test ${id}`,owner:id===1,kind:id===1?"admin":"member",suspended:false} as User,tokenHash:"test",csrf:"test"};
    next();
  });
  app.use("/api",legalCaseRoutes(pool));
  app.use(((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const status=error instanceof HttpError?error.status:error instanceof z.ZodError?400:500;
    res.status(status).json({error:{code:error instanceof HttpError?error.code:"test_error"}});
  }) as express.ErrorRequestHandler);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
  const addr=server.address();assert.ok(addr&&typeof addr!=="string");
  const url=`http://127.0.0.1:${addr.port}/api`;
  const call=async(method:string,path:string,body?:unknown,user=1)=>{
    const response=await fetch(url+path,{method,headers:{"content-type":"application/json","x-test-user":String(user)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const path="/legal/records/10/images/100";
  const originalRecord=(await db.query("SELECT * FROM legal_records WHERE id=10")).rows[0];
  const originalImage=(await db.query("SELECT * FROM legal_document_images WHERE id=100")).rows[0];
  const peers=(await db.query("SELECT * FROM legal_document_images WHERE id<>100 ORDER BY id")).rows;
  const originalLinks=(await db.query("SELECT * FROM legal_record_cases ORDER BY record_id,case_id")).rows;
  const meta=await call("GET",path+"/metadata",undefined,3);
  assert.equal(meta.status,200);
  assert.deepEqual(Object.keys(meta.data.item).sort(),["bytes","filename","id","mimeType","sha256"]);
  assert.equal(meta.data.item.sha256,sha(png));
  assert.equal(meta.data.item.bytes,png.length);
  assert.equal((await call("GET",path+"/metadata",undefined,5)).status,403);
  assert.equal((await call("GET","/legal/records/40/images/400/metadata",undefined,2)).status,403,"every linked case must be readable");
  assert.equal((await call("GET","/legal/records/50/images/500/metadata",undefined,2)).status,403);
  assert.equal((await call("GET","/legal/records/10/images/200/metadata")).status,404,"record/image path cannot borrow another record's image");
  const valid={dataUrl:dataUrl(replacement),expectedSha256:sha(png)};
  for(const user of [3,4,5]){
    assert.equal((await call("PUT",path,valid,user)).status,403);
    assert.equal((await call("DELETE",path,{expectedSha256:sha(png)},user)).status,403);
  }
  assert.equal((await call("PUT","/legal/records/40/images/400",valid,2)).status,403,"editor access is required on every shared case");
  assert.equal((await call("DELETE","/legal/records/40/images/400",{expectedSha256:sha(png)},2)).status,403);
  assert.equal((await call("PUT","/legal/records/10/images/200",valid)).status,404);
  assert.equal((await call("DELETE","/legal/records/10/images/200",{expectedSha256:sha(png)})).status,404);
  for(const body of [
    {dataUrl:dataUrl(png)}, {...valid,expectedSha256:"no"}, {...valid,dataUrl:dataUrl(png,"image/gif")},
    {...valid,dataUrl:dataUrl(Buffer.from("this is not PNG"))}, {...valid,dataUrl:"data:image/png;base64,not%base64"},
    {...valid,dataUrl:dataUrl(Buffer.concat([png,Buffer.alloc(2097153)]))},
    {...valid,dataUrl:"x".repeat(3000001)}, {...valid,filename:"x".repeat(251)},
  ])assert.equal((await call("PUT",path,body)).status,400);
  assert.equal((await call("DELETE",path,{})).status,400);
  assert.equal((await call("PUT",path,{...valid,expectedSha256:"0".repeat(64)})).status,409);
  assert.equal((await call("DELETE",path,{expectedSha256:"0".repeat(64)})).status,409);
  await db.query("INSERT INTO page_settings VALUES('public.legal-cases',NULL,false)");
  assert.equal((await call("PUT",path,valid,2)).status,403);
  assert.equal((await call("DELETE",path,{expectedSha256:sha(png)},2)).status,403);
  await db.query("DELETE FROM page_settings");
  assert.equal((await call("PUT","/legal/records/30/images/300",valid,2)).status,400);
  assert.equal((await call("DELETE","/legal/records/30/images/300",{expectedSha256:sha(png)},2)).status,400);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events")).rows[0].n),0,"rejected requests have no audit or mutation");
  for(const method of ["UPDATE","DELETE"] as const){
    intervene=method;
    const result=await call(method==="UPDATE"?"PUT":"DELETE",path,method==="UPDATE"?valid:{expectedSha256:sha(png)},2);
    assert.equal(result.status,409,"byte equality must guard changes after the initial hash comparison");
    assert.equal(sha((await db.query("SELECT image_bytes FROM legal_document_images WHERE id=100")).rows[0].image_bytes),sha(png));
  }
  const accepted=await call("PUT",path,valid,2);
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.item.id,100);
  assert.equal(accepted.data.item.sha256,sha(replacement));
  assert.equal(accepted.data.item.filename,"original.png","omitted filename preserves the stored filename");
  const saved=(await db.query("SELECT * FROM legal_document_images WHERE id=100")).rows[0];
  assert.equal(saved.created_at.toISOString(),originalImage.created_at.toISOString());
  assert.equal(saved.uploaded_by,originalImage.uploaded_by);
  assert.equal((await call("PUT",path,valid,2)).status,409,"old expected SHA cannot overwrite newer bytes");
  assert.equal((await call("DELETE",path,{expectedSha256:sha(png)},2)).status,409);
  const renamed=await call("PUT",path,{dataUrl:dataUrl(replacement),expectedSha256:sha(replacement),filename:"corrected.png"},2);
  assert.equal(renamed.status,200);assert.equal(renamed.data.item.filename,"corrected.png");
  const removed=await call("DELETE",path,{expectedSha256:sha(replacement)},2);
  assert.equal(removed.status,200);assert.deepEqual(removed.data.item,{id:100,deleted:true});
  assert.equal((await call("GET",path+"/metadata")).status,404);
  assert.equal((await call("DELETE",path,{expectedSha256:sha(replacement)},2)).status,404);
  assert.deepEqual((await db.query("SELECT * FROM legal_records WHERE id=10")).rows[0],originalRecord);
  assert.deepEqual((await db.query("SELECT * FROM legal_record_cases ORDER BY record_id,case_id")).rows,originalLinks);
  assert.deepEqual((await db.query("SELECT * FROM legal_document_images WHERE id<>100 ORDER BY id")).rows,peers,"all other images and records survive");
  const audits=(await db.query("SELECT * FROM audit_events ORDER BY id")).rows;
  assert.equal(audits.length,3);
  assert.equal(audits[0].actor_id,2);
  assert.equal(audits[0].before_value.sha256,sha(png));
  assert.equal(audits[0].after_value.sha256,sha(replacement));
  assert.equal(audits[0].after_value.bytes,replacement.length);
  assert.equal(audits[2].after_value.deleted,true);
  for(const row of audits){
    assert.equal(row.target_type,"legalImage");assert.equal(row.target_id,100);
    for(const snapshot of [row.before_value,row.after_value]){
      assert.ok(!Object.hasOwn(snapshot,"image_bytes"));assert.ok(!Object.hasOwn(snapshot,"dataUrl"));
    }
  }
});

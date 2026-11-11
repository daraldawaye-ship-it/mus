import assert from "node:assert/strict";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, QueryResultRow } from "pg";
import { centralAccessRoutes } from "../apps/api/src/routes-central-access.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { userDTO } from "../apps/api/src/repositories/models.ts";
import { permissionRequest } from "../apps/api/src/services/permission-rules.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";

// An isolated PostgreSQL engine with only the tables used by these routes.
// No connection string, external database, financial document, or live identity.
test("central permission assignments preserve grants and enforce administration boundaries", async t=>{
  const db=new PGlite();
  await db.exec(`
    CREATE TABLE users (
      id integer PRIMARY KEY,name text,display_name text,email text,phone text DEFAULT '',
      image text,kind text DEFAULT 'member',owner boolean DEFAULT false,
      archived boolean DEFAULT false,suspended boolean DEFAULT false,
      editor boolean DEFAULT false,monitor boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE companies (
      id integer PRIMARY KEY,name text,phone text DEFAULT '',address text DEFAULT '',
      created_by integer DEFAULT 1,created_at timestamptz DEFAULT now()
    );
    CREATE TABLE employees (
      id integer PRIMARY KEY,company_id integer,user_id integer,name text,
      phone text DEFAULT '',role text DEFAULT 'employee',position_keys text[] DEFAULT '{employee}',
      active boolean DEFAULT true,is_general_manager boolean DEFAULT false,
      permissions text[] DEFAULT '{}',created_by integer DEFAULT 1,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE legacy_import_runs (
      company_id integer,status text,defer_projections boolean,idempotency_key uuid
    );
    CREATE TABLE central_access_policies (
      company_id integer,resource_key text,view_positions text[],edit_positions text[],
      revision integer DEFAULT 1,updated_by integer,updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE permission_definitions (key text,active boolean);
    CREATE TABLE employee_permission_rules (
      company_id integer,employee_id integer,permission_key text,effect text,active boolean
    );
    CREATE TABLE role_permission_rules (
      company_id integer,role_id integer,permission_key text,effect text,active boolean
    );
    CREATE TABLE company_roles (company_id integer,id integer,active boolean);
    CREATE TABLE employee_role_assignments (
      company_id integer,employee_id integer,role_id integer,active boolean
    );
    CREATE TABLE audit_events (
      actor_id integer,actor_name text,scope text,company_id integer,action text,
      target_type text,target_id integer,before_value jsonb,after_value jsonb
    );
    INSERT INTO users(id,name,display_name,email,owner) VALUES
      (1,'Owner','Owner','owner@central.test',true),
      (2,'Manager','Manager','manager@central.test',false),
      (3,'Staff','Staff','staff@central.test',false),
      (4,'Other tenant','Other tenant','other@central.test',false),
      (5,'Second manager','Second manager','second@central.test',false),
      (6,'Cashier','Cashier','cashier@central.test',false),
      (7,'Colleague','Colleague','colleague@central.test',false);
    INSERT INTO companies(id,name) VALUES (1,'First'),(2,'Second');
    INSERT INTO employees(id,company_id,user_id,name,position_keys,permissions,is_general_manager) VALUES
      (1,1,1,'Owner','{employee}','{}',false),
      (2,1,2,'Manager','{employee}','{}',true),
      (3,1,3,'Staff','{employee,sales}','{commerce.manage,finance.post}',false),
      (4,2,4,'Other tenant','{employee,sales}','{items.manage}',false),
      (5,1,5,'Second manager','{employee}','{}',true),
      (6,1,6,'Cashier','{employee,cashier}','{finance.post}',false),
      (7,1,7,'Colleague','{employee,sales}','{items.view}',false);
    INSERT INTO central_access_policies(company_id,resource_key,view_positions,edit_positions)
      VALUES (1,'page:company.central-access','{employee}','{employee}'),
             (1,'permission:finance.manage','{employee}','{employee}');
  `);
  const client={
    query:async(sql:string,params:unknown[]=[])=>{
      const result=await db.query(sql,params);
      return {...result,rowCount:result.rows.length || result.affectedRows || 0};
    },
    release(){},
  };
  const pool={...client,connect:async()=>client} as unknown as Pool;
  const router=centralAccessRoutes(pool);
  const app=express();
  app.use(express.json());
  app.use(async(req,_res,next)=>{
    const row=await db.query<QueryResultRow>("SELECT * FROM users WHERE id=$1",[Number(req.headers["x-test-actor"]??1)]);
    if(row.rows[0])req.auth={user:userDTO(row.rows[0]),tokenHash:"test-only",csrf:"test-only"};
    permissionRequest.run(req,next);
  });
  app.use("/api",router);
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
    if(error instanceof HttpError)res.status(error.status).json({code:error.code,message:error.message});
    else res.status(500).json({message:String(error)});
  };
  app.use(errors);
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();
  assert(address && typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}/api`;
  t.after(async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await db.close();
  });
  const path=(employeeId:number,permission="finance.manage",companyId=1)=>
    `/companies/${companyId}/central-access/permission:${permission}/employees/${employeeId}`;
  async function request(method:string,url:string,body?:unknown,actor=1){
    const response=await fetch(base+url,{method,headers:{
      "content-type":"application/json","x-test-actor":String(actor),
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  }
  async function grants(id:number){
    return (await db.query<{permissions:string[]}>("SELECT permissions FROM employees WHERE id=$1",[id])).rows[0]!.permissions;
  }

  await t.test("catalog publishes the exact single-grant write contract",()=>{
    const catalog=apiCatalog(router,{operation:"PATCH /companies/:companyId/central-access/:key/employees/:employeeId"});
    const operation=catalog.operations[0] as unknown as {bodySchema:{required:string[];additionalProperties:boolean}};
    assert.deepEqual(operation.bodySchema.required,["granted","expectedGranted"]);
    assert.equal(operation.bodySchema.additionalProperties,false);
  });
  await t.test("read shows actual assignments without activating dormant all-employee presets",async()=>{
    const before=await db.query("SELECT id,permissions FROM employees ORDER BY id");
    const response=await request("GET","/companies/1/central-access");
    assert.equal(response.status,200);
    const resource=response.body.resources.find((r:{key:string})=>r.key==="permission:finance.manage");
    assert.equal(resource.integrated,true);
    assert.equal(resource.policy,null);
    assert.equal(resource.controlMode,"employees");
    assert(!response.body.permissionEmployees.some((e:{id:number})=>e.id===4));
    const staff=response.body.permissionEmployees.find((e:{id:number})=>e.id===3);
    assert.deepEqual(staff.permissions,["commerce.manage","finance.post"]);
    assert.equal(Object.hasOwn(staff,"email"),false);
    assert.deepEqual((await db.query("SELECT id,permissions FROM employees ORDER BY id")).rows,before.rows);
  });
  await t.test("changing one bit preserves unrelated grants and does not alter same-position colleagues",async()=>{
    const colleague=await grants(7);
    const added=await request("PATCH",path(3),{granted:true,expectedGranted:false});
    assert.equal(added.status,200,JSON.stringify(added.body));
    assert.deepEqual(added.body.employee.permissions,["commerce.manage","finance.manage","finance.post"]);
    assert.deepEqual(await grants(7),colleague);
    const removed=await request("PATCH",path(3),{granted:false,expectedGranted:true});
    assert.equal(removed.status,200);
    assert.deepEqual(await grants(3),["commerce.manage","finance.post"]);
    const audits=await db.query<{action:string;before_value:{permissions:string[]};after_value:{permissions:string[]}}>(
      "SELECT action,before_value,after_value FROM audit_events WHERE target_id=3 ORDER BY action");
    assert.equal(audits.rows.filter(row=>row.action==="employee.update").length,2);
    assert.equal(audits.rows.filter(row=>row.action==="card.field.update").length,2);
  });
  await t.test("a stale grant cannot overwrite a newer assignment",async()=>{
    const stale=await request("PATCH",path(3),{granted:false,expectedGranted:true});
    assert.equal(stale.status,409);
    assert.equal(stale.body.code,"stale_permission_assignment");
    assert.deepEqual(await grants(3),["commerce.manage","finance.post"]);
  });
  await t.test("ordinary employees cannot inspect or edit grants even with central page positions",async()=>{
    assert.equal((await request("GET","/companies/1/central-access",undefined,3)).status,403);
    assert.equal((await request("PATCH",path(7),{granted:true,expectedGranted:false},3)).status,403);
    assert.deepEqual(await grants(7),["items.view"]);
  });
  await t.test("company boundaries are checked before finding a target employee",async()=>{
    assert.equal((await request("PATCH",path(4),{granted:true,expectedGranted:false})).status,404);
    assert.equal((await request("PATCH",path(4,"finance.manage",2),{granted:true,expectedGranted:false},2)).status,403);
    assert.deepEqual(await grants(4),["items.manage"]);
  });
  await t.test("owner grants stay protected and managers cannot change another general manager",async()=>{
    assert.equal((await request("PATCH",path(1),{granted:true,expectedGranted:false})).status,403);
    assert.equal((await request("PATCH",path(5),{granted:true,expectedGranted:false},2)).status,403);
    const ownerEdit=await request("PATCH",path(5),{granted:true,expectedGranted:false});
    assert.equal(ownerEdit.status,200);
    assert.equal(ownerEdit.body.employee.isGeneralManager,true);
  });
  await t.test("inherited cashier access remains a role property, and stored role presets cannot be edited as if active",async()=>{
    const response=await request("GET","/companies/1/central-access");
    const cashier=response.body.permissionEmployees.find((e:{id:number})=>e.id===6);
    assert(cashier.positions.includes("cashier"));
    assert(!cashier.permissions.includes("finance.own-cashbox.view"));
    const put=await request("PUT","/companies/1/central-access/permission:finance.manage",{
      viewPositions:[],editPositions:[],revision:1,
    });
    assert.equal(put.status,409);
    assert.equal(put.body.code,"permission_assignments_only");
    const deleted=await request("DELETE","/companies/1/central-access/permission:finance.manage",{revision:1});
    assert.equal(deleted.status,409);
    assert.equal(deleted.body.code,"permission_assignments_only");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { alraesyApiCatalog } from "../apps/api/src/routes-alraesy-mcp.ts";

test("Alraesy catalog discovers CRUD routes without exposing login or setup",()=>{
  const router=Router();
  router.get("/companies/:companyId/items",(_req,res)=>res.json({}));
  router.post("/companies/:companyId/items",(_req,res)=>res.json({}));
  router.patch("/users/:id",(_req,res)=>res.json({}));
  router.post("/auth/password",(_req,res)=>res.json({}));
  router.post("/auth/login",(_req,res)=>res.json({}));
  router.post("/setup",(_req,res)=>res.json({}));
  const ops=alraesyApiCatalog([router]);
  assert.deepEqual(ops,[
    {method:"GET",path:"/companies/:companyId/items"},
    {method:"POST",path:"/companies/:companyId/items"},
    {method:"PATCH",path:"/users/:id"},
  ]);
});
test("Alraesy catalog de-duplicates repeated registered endpoint definitions",()=>{
  const a=Router(),b=Router();
  a.get("/companies",(_req,res)=>res.json({}));
  b.get("/companies",(_req,res)=>res.json({}));
  assert.equal(alraesyApiCatalog([a,b]).length,1);
});

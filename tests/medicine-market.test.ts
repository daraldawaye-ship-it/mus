import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { MarketCard, MarketContribution, MarketDetail, MarketMeta, MarketKind } from "../packages/contracts/src/medicine-market.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const password = "Market-test-password-2026";
const origin = "http://localhost";
const basePath = "/medicine-market";
type Page<T> = { items:T[];total:number;page:number;pageSize:number };
class Client {
  cookie = "";
  csrf = "";
  constructor(readonly base:string) {}
  async request<T = Record<string,unknown>>(method:string,path:string,body?:unknown) {
    const response = await fetch(this.base + "/api" + path, {
      method,
      headers:{cookie:this.cookie,...(method === "GET" ? {} : {"content-type":"application/json",origin,"x-csrf-token":this.csrf})},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) this.cookie = value.split(";")[0]!;
    const data = await response.json() as T;
    if (data && typeof data === "object" && "csrf" in data) this.csrf = (data as {csrf:string}).csrf;
    return {status:response.status,data};
  }
  async ok<T = Record<string,unknown>>(method:string,path:string,body?:unknown,expected=200):Promise<T> {
    const r = await this.request<T>(method,path,body);
    assert.equal(r.status,expected,method + " " + path + ": " + JSON.stringify(r.data));
    return r.data;
  }
  async create(kind:MarketKind,name:string) {
    return (await this.ok<{card:MarketCard}>("POST",basePath+"/cards",{kind,name,idempotencyKey:randomUUID()},201)).card;
  }
  async propose(cardId:number,fieldKey:string,value:unknown,expectedValue:unknown,source="صورة العبوة") {
    return this.ok<{card:MarketCard;contribution:MarketContribution}>("POST",`${basePath}/cards/${cardId}/contributions`,{fieldKey,value,expectedValue,source,idempotencyKey:randomUUID()},201);
  }
  async review(id:number,decision:"approve"|"reject"="approve") {
    return this.ok<{card:MarketCard;contribution:MarketContribution}>("POST",`${basePath}/contributions/${id}/review`,{decision});
  }
  async detail(id:number) { return this.ok<MarketDetail>("GET",`${basePath}/cards/${id}`); }
}

test("public medicine market: approvals, protected fields and community activity", async t => {
  const schema = "market_test_" + randomUUID().replaceAll("-","");
  const runtime = await createApp({databaseUrl,schema,appOrigin:origin,serveStatic:false,production:false});
  const server = runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close();
    const cleanup = new Pool({connectionString:databaseUrl});
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });
  const url = `http://127.0.0.1:${address.port}`;
  const ownerUser = await provisionOwner(runtime.pool,{name:"Market owner",displayName:"Market owner",email:"owner@market.test",password});
  const owner = new Client(url),member = new Client(url),second = new Client(url),guest = new Client(url);
  await owner.ok("POST","/auth/login",{email:ownerUser.email,password});
  const register = async (client:Client,email:string) => {
    await client.ok("POST","/auth/register",{name:email,displayName:email,email,phone:"",password},201);
    return (await runtime.pool.query("SELECT id FROM users WHERE email=$1",[email])).rows[0].id as number;
  };
  const memberId = await register(member,"member@market.test");
  const secondId = await register(second,"second@market.test");
  let medicine:MarketCard;

  await t.test("field approvals are atomic, stale-safe, idempotent and award points once",async () => {
    assert.equal((await guest.ok<MarketMeta>("GET",basePath+"/meta")).userPoints,"0");
    assert.equal((await runtime.pool.query("SELECT count(*)::int n FROM companies")).rows[0].n,0);
    for (const [fieldKey,addPoints,editPoints] of [["name",5,2],["description",7,3],["purchasePrice",4,2]] as const) {
      await owner.ok("PUT",basePath+"/policies",{kind:"medicine",fieldKey,addPoints,editPoints,revision:0});
    }
    assert.equal((await member.request("PUT",basePath+"/policies",{kind:"medicine",fieldKey:"name",addPoints:999,editPoints:999,revision:1})).status,403);
    const input = {kind:"medicine",name:"أموكسيسيلين — عبوة اختبار 20 قرصًا",idempotencyKey:randomUUID()};
    medicine = (await member.ok<{card:MarketCard}>("POST",basePath+"/cards",input,201)).card;
    assert.equal(medicine.status,"pending");
    assert.equal((await member.ok<{card:MarketCard}>("POST",basePath+"/cards",input,201)).card.id,medicine.id);
    assert.equal((await member.request("POST",basePath+"/cards",{...input,name:"اسم مختلف"})).status,409);
    assert.equal((await second.request("POST",basePath+"/cards",{...input,name:"اموكسيسيلين — عبوة اختبار 20 قرصًا",idempotencyKey:randomUUID()})).status,409);
    assert.equal((await guest.ok<Page<MarketCard>>("GET",basePath+"/cards")).total,0);
    assert.equal((await guest.request("GET",`${basePath}/cards/${medicine.id}`)).status,404);
    const creation = (await member.detail(medicine.id)).contributions.find(c => c.fieldKey === "name")!;
    assert(creation);
    assert.equal((await member.request("POST",`${basePath}/contributions/${creation.id}/review`,{decision:"approve"})).status,403);
    const approved = await owner.review(creation.id);
    assert.equal(approved.card.status,"published");
    assert.equal(approved.contribution.awardedPoints,5);
    assert.equal((await guest.ok<Page<MarketCard>>("GET",basePath+"/cards?q=اموكسيسيلين")).items[0]?.id,medicine.id);

    const proposal = {fieldKey:"description",value:"علبة تحتوي شريطين؛ كل شريط 10 أقراص",expectedValue:null,source:"صورة العبوة",idempotencyKey:randomUUID()};
    const submitted = await member.ok<{contribution:MarketContribution}>("POST",`${basePath}/cards/${medicine.id}/contributions`,proposal,201);
    assert.equal(submitted.contribution.published,false);
    assert.equal((await guest.detail(medicine.id)).card.data.description,undefined);
    const replay = await member.ok<{contribution:MarketContribution}>("POST",`${basePath}/cards/${medicine.id}/contributions`,proposal,201);
    assert.equal(replay.contribution.id,submitted.contribution.id);
    assert.equal((await member.request("POST",`${basePath}/cards/${medicine.id}/contributions`,{...proposal,value:"قيمة مختلفة"})).status,409);
    const reviewed = await Promise.all([owner.review(submitted.contribution.id),owner.review(submitted.contribution.id)]);
    assert(reviewed.every(r => r.contribution.status === "approved" && r.contribution.awardedPoints === 7));
    const award = await runtime.pool.query("SELECT count(*)::int n,sum(points)::int points FROM medicine_market_points WHERE contribution_id=$1",[submitted.contribution.id]);
    assert.deepEqual(award.rows[0],{n:1,points:7});
    assert.equal((await member.ok<MarketMeta>("GET",basePath+"/meta")).userPoints,"12");
    await assert.rejects(runtime.pool.query("UPDATE medicine_market_points SET points=99 WHERE contribution_id=$1",[submitted.contribution.id]),/immutable/);

    const a = await member.propose(medicine.id,"description","عبوة مصححة أولى",proposal.value);
    const b = await second.propose(medicine.id,"description","عبوة مصححة ثانية",proposal.value);
    await owner.review(a.contribution.id);
    assert.equal((await member.ok<MarketMeta>("GET",basePath+"/meta")).userPoints,"15", "A meaningful accepted later edit earns its own edit points");
    const stale = await owner.review(b.contribution.id);
    assert.equal(stale.contribution.status,"conflict");
    assert.equal(stale.card.data.description,"عبوة مصححة أولى");
    assert.equal((await runtime.pool.query("SELECT count(*)::int n FROM medicine_market_points WHERE contribution_id=$1",[b.contribution.id])).rows[0].n,0);
    assert.equal((await member.propose(medicine.id,"description","مقترح مرفوض","عبوة مصححة أولى").then(r => owner.review(r.contribution.id,"reject"))).contribution.awardedPoints,0);

    const price = await owner.propose(medicine.id,"purchasePrice","1250.00",null);
    assert.equal(price.contribution.status,"pending");
    assert.equal(price.contribution.published,false);
    assert.equal((await guest.detail(medicine.id)).card.data.purchasePrice,undefined);
    const selfReviewed = await owner.review(price.contribution.id);
    assert.equal(selfReviewed.contribution.awardedPoints,0);
    assert.equal((await guest.detail(medicine.id)).card.data.purchasePrice,"1250");
    const currency = await owner.propose(medicine.id,"currency","YER",null);
    assert.equal(currency.contribution.published,false);
    assert.equal((await guest.detail(medicine.id)).card.data.currency,undefined);
    await owner.review(currency.contribution.id);
    assert.equal((await guest.detail(medicine.id)).card.data.currency,"YER");
    const renamed = await member.propose(medicine.id,"name","أموكسيسيلين — العبوة المصححة للاختبار",medicine.name);
    await owner.review(renamed.contribution.id);
    const originalReplay = await member.ok<{card:MarketCard}>("POST",basePath+"/cards",input,201);
    assert.equal(originalReplay.card.id,medicine.id);
    assert.equal(originalReplay.card.name,renamed.contribution.value);
    assert.equal((await guest.request("POST",`${basePath}/cards/${medicine.id}/contributions`,proposal)).status,401);
  });

  await t.test("typed relations and multi-ingredient strengths survive approval while private fields never leak",async () => {
    const scientific = await owner.create("scientific-name","Amikacin — test");
    const secondScientific = await owner.create("scientific-name","Amitriptyline — test");
    const dosage = await owner.create("dosage-form","قارورة اختبار");
    const pharmacy = await owner.create("pharmacy","صيدلية اختبار السوق");
    const composition = await owner.create("composition","تركيب اختبار متعدد المكونات");
    assert.equal((await member.request("POST",`${basePath}/cards/${medicine.id}/contributions`,{fieldKey:"compositionId",value:pharmacy.id,expectedValue:null,idempotencyKey:randomUUID()})).status,400);
    const ingredients = [{scientificId:scientific.id,strength:"500",unit:"mg",denominator:"2",denominatorUnit:"ml"},{scientificId:secondScientific.id,strength:"12.5",unit:"mg"}];
    const proposed = await member.propose(composition.id,"ingredients",ingredients,null);
    const approved = await owner.review(proposed.contribution.id);
    assert.deepEqual(approved.card.data.ingredients,ingredients);
    await owner.propose(composition.id,"dosageFormId",dosage.id,null);
    const linked = await member.propose(medicine.id,"compositionId",composition.id,null);
    await owner.review(linked.contribution.id);
    assert.equal((await guest.detail(medicine.id)).card.data.compositionId,composition.id);
    const contacts = [{name:"مسؤول المشتريات",role:"مشتريات",phone:"+967700000001"},{name:"مسؤول الاستعلامات",phone:"+967700000002"}];
    await owner.propose(pharmacy.id,"contacts",contacts,null);
    assert.deepEqual((await guest.detail(pharmacy.id)).card.data.contacts,contacts);
    const invalidStrength = await member.request("POST",`${basePath}/cards/${composition.id}/contributions`,{fieldKey:"ingredients",value:[{scientificId:scientific.id,strength:"0",unit:"mg"}],expectedValue:ingredients,idempotencyKey:randomUUID()});
    assert.equal(invalidStrength.status,400);

    const secret = "PRIVATE_MINISTRY_NOTICE_TEST";
    await owner.propose(medicine.id,"ministryNotes",secret,null);
    await owner.propose(medicine.id,"ministryPrice","1500",null);
    await owner.propose(medicine.id,"ministryNoticeUntil","2027-01-01",null);
    await owner.propose(medicine.id,"accountingMappings",[{system:"نظام اختبار",identifier:"PRIVATE_ACCOUNTING_ID_TEST"}],null);
    for (const reader of [guest,member,second]) {
      const meta = await reader.ok<MarketMeta>("GET",basePath+"/meta");
      assert(meta.types.every(type => type.fields.every(field => field.visibility === "public")));
      const detail = await reader.detail(medicine.id);
      for (const field of ["ministryNotes","ministryPrice","ministryNoticeUntil","accountingMappings"]) assert(!Object.hasOwn(detail.card.data,field));
      assert(!JSON.stringify(detail).includes(secret));
      assert(!JSON.stringify(detail).includes("PRIVATE_ACCOUNTING_ID_TEST"));
      assert.equal((await reader.ok<Page<MarketCard>>("GET",basePath+"/cards?q="+encodeURIComponent(secret))).total,0);
      assert.equal((await reader.ok<Page<MarketCard>>("GET",basePath+"/cards?q=PRIVATE_ACCOUNTING_ID_TEST")).total,0);
    }
    const own = await member.ok<Page<MarketContribution>>("GET",basePath+"/contributions?mine=true");
    assert(own.items.every(c => c.authorId === memberId && !c.fieldKey.startsWith("ministry") && c.fieldKey !== "accountingMappings"));
    assert.equal((await member.request("POST",`${basePath}/cards/${medicine.id}/contributions`,{fieldKey:"ministryNotes",value:"محاولة تعديل",expectedValue:null,idempotencyKey:randomUUID()})).status,403);
    assert.equal((await owner.detail(medicine.id)).card.data.ministryNotes,secret);
    await runtime.pool.query("UPDATE users SET monitor=true WHERE id=$1",[secondId]);
    const monitored = await second.detail(medicine.id);
    assert.equal(monitored.card.data.ministryNotes,secret);
    assert(!Object.hasOwn(monitored.card.data,"accountingMappings"));
    const audit = await owner.ok<{items:unknown[]}>("GET","/audit?pageSize=100");
    assert(!JSON.stringify(audit).includes(secret));
    assert(!JSON.stringify(audit).includes("PRIVATE_ACCOUNTING_ID_TEST"));
  });

  await t.test("engagement, suspension, archive and page flags enforce current server policy",async () => {
    const pendingComment = await member.ok<{comment:{id:number;status:string}}>("POST",`${basePath}/cards/${medicine.id}/comments`,{text:"تعليق يتطلب المصادقة",idempotencyKey:randomUUID()},201);
    assert.equal(pendingComment.comment.status,"pending");
    assert(!(await guest.detail(medicine.id)).comments.some(c => c.id === pendingComment.comment.id));
    await owner.ok("POST",`${basePath}/comments/${pendingComment.comment.id}/review`,{decision:"approve"});
    assert((await guest.detail(medicine.id)).comments.some(c => c.id === pendingComment.comment.id));
    const trustedComment = await second.ok<{comment:{id:number;status:string}}>("POST",`${basePath}/cards/${medicine.id}/comments`,{text:"تعليق المراقب",idempotencyKey:randomUUID()},201);
    assert.equal(trustedComment.comment.status,"approved");
    for (let n=0;n<2;n++) await member.ok("PUT",`${basePath}/cards/${medicine.id}/reaction`,{liked:true,rating:4});
    let detail = await guest.detail(medicine.id);
    assert.equal(detail.card.likes,1);
    assert.equal(detail.card.ratingCount,1);
    assert.equal(detail.card.ratingAverage,4);
    await second.ok("PUT",`${basePath}/cards/${medicine.id}/reaction`,{liked:true,rating:2});
    detail = await guest.detail(medicine.id);
    assert.equal(detail.card.likes,2);
    assert.equal(detail.card.ratingAverage,3);
    await member.ok("PUT",`${basePath}/cards/${medicine.id}/reaction`,{liked:false,rating:null});
    detail = await guest.detail(medicine.id);
    assert.equal(detail.card.likes,1);
    assert.equal(detail.card.ratingCount,1);

    await owner.ok("PATCH",`/users/${memberId}`,{suspended:true});
    assert.equal((await member.request("POST",basePath+"/cards",{kind:"pharmacy",name:"لا يسمح للموقوف",idempotencyKey:randomUUID()})).status,403);
    assert.equal((await member.request("PUT",`${basePath}/cards/${medicine.id}/reaction`,{liked:true})).status,403);
    assert.equal((await member.request("POST",`${basePath}/cards/${medicine.id}/comments`,{text:"موقوف",idempotencyKey:randomUUID()})).status,403);
    await owner.ok("PATCH",`/users/${memberId}`,{suspended:false});
    const before = (await owner.detail(medicine.id)).card;
    assert.equal((await member.request("PATCH",`${basePath}/cards/${medicine.id}/archive`,{archived:true,revision:before.revision})).status,403);
    const archived = await owner.ok<{card:MarketCard}>("PATCH",`${basePath}/cards/${medicine.id}/archive`,{archived:true,revision:before.revision});
    assert.equal(archived.card.archived,true);
    assert.equal((await guest.request("GET",`${basePath}/cards/${medicine.id}`)).status,404);
    assert(!(await guest.ok<Page<MarketCard>>("GET",basePath+"/cards")).items.some(c => c.id === medicine.id));
    assert.equal((await owner.request("PATCH",`${basePath}/cards/${medicine.id}/archive`,{archived:false,revision:before.revision})).status,409);
    await owner.ok("PATCH",`${basePath}/cards/${medicine.id}/archive`,{archived:false,revision:archived.card.revision});

    const setting = await owner.ok<{page:{revision:number}}>("PUT","/page-catalog/public.medicine-market/settings",{companyId:null,visible:true,enabled:false,order:400,revision:null});
    assert.equal((await guest.request("GET",basePath+"/cards")).status,403);
    assert.equal((await member.request("POST",basePath+"/cards",{kind:"pharmacy",name:"صفحة موقوفة",idempotencyKey:randomUUID()})).status,403);
    await owner.ok("PUT","/page-catalog/public.medicine-market/settings",{companyId:null,visible:true,enabled:true,order:400,revision:setting.page.revision});
    assert((await guest.ok<Page<MarketCard>>("GET",basePath+"/cards")).total>0);
  });
});

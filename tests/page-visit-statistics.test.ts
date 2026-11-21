import {pageByKey,pageHref,pageKeyForLocation,pageRuleAllows,type User} from "../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {PGlite} from "@electric-sql/pglite";
import type {Database} from "../apps/api/src/db.ts";
import {readPageVisitStatistics,searchPageVisitUsers} from "../apps/api/src/services/page-visit-statistics.ts";

test("counts only recorded accepted opens, combines company scopes, filters exact actor, and ranks/paginates",async()=>{
 const client=await PGlite.create(),db=client as unknown as Database;
 try{
  await client.exec(`
   CREATE TABLE audit_events(actor_id int,action text,target_type text,scope text,company_id int,after_value jsonb,created_at timestamptz);
   INSERT INTO audit_events SELECT actor,action,target,scope,company,jsonb_build_object('pageKey',key,'pageName','old text','recordId',999),now()-make_interval(days=>days)
   FROM (VALUES
    (1,'page.open','page','company',2,'company.items',1),
    (1,'page.open','page','company',3,'company.items',2),
    (2,'page.open','page','company',2,'company.items',91),
    (1,'page.open','page','public',NULL,'public.home',1),
    (2,'page.open','page','public',NULL,'public.home',2),
    (1,'page.open','page','company',2,'company.accounts',1),
    (1,'page.open','wrong','company',2,'company.accounts',1),
    (1,'page_view','page','public',NULL,'public.home',0),
    (1,'page.open','page','company',2,'public.home',0),
    (1,'page.open','page','public',NULL,'public./record/123',0)
   ) t(actor,action,target,scope,company,key,days);
  `);
  const overall=await readPageVisitStatistics(db,undefined,"all",1,25);
  assert.deepEqual(overall.items.map(({pageKey,visits,position})=>[pageKey,visits,position]),
    [["company.items","3",1],["public.home","2",2],["company.accounts","1",3]]);
  assert.equal(overall.total,3);
  assert.notEqual(overall.items[0]?.name,"old text");
  assert.ok(overall.items.every(row=>!Object.hasOwn(row,"recordId")&&!Object.hasOwn(row,"userId")));
  const second=await readPageVisitStatistics(db,1,"all",2,1);
  assert.deepEqual(second.items.map(({pageKey,visits,position})=>[pageKey,visits,position]),[["company.accounts","1",2]]);
  assert.deepEqual((await readPageVisitStatistics(db,2,"90",1,25)).items.map(r=>r.pageKey),["public.home"]);
  assert.deepEqual((await readPageVisitStatistics(db,99,"all",1,25)).items,[]);
 }finally{await client.close();}
});
test("name lookup tolerates duplicate display names safely and never searches contact fields",async()=>{
 const client=await PGlite.create(),db=client as unknown as Database;
 try{
  await client.exec(`CREATE TABLE users(id int,name text,display_name text,email text,phone text);
   INSERT INTO users VALUES(7,'Other','Same','nolook@example.test','100'),(8,'Different','Same','private@example.test','200'),(9,'Literal_','Literal_%','private2@example.test','300');`);
  assert.deepEqual((await searchPageVisitUsers(db,"same")).items,[{id:7,name:"Same"},{id:8,name:"Same"}]);
  assert.deepEqual((await searchPageVisitUsers(db,"private")).items,[]);
  assert.deepEqual((await searchPageVisitUsers(db,"200")).items,[]);
  assert.deepEqual((await searchPageVisitUsers(db,"_%")).items,[{id:9,name:"Literal_%"}]);
 }finally{await client.close();}
});
test("both routes are owner-only private reads and frontend chooses exact id without new tracking",async()=>{
 const file=(name:string)=>readFile(new URL("../apps/"+name,import.meta.url),"utf8");
 const routes=await file("api/src/routes-pages.ts"),web=await file("web/src/pages/PageVisitStatisticsPage.tsx"),app=await file("web/src/App.tsx");
 const snippet=routes.split("const assertVisitStatsOwner")[1]?.split('router.post(')[0]??"";
 assert.match(snippet,/ownerOnly\(await currentActor\(client,actor\(req\),false\)\)/);
 assert.match(snippet,/X-Alraesy-Employee-Preview/);
 assert.equal((snippet.match(/await assertVisitStatsOwner\(/g)??[]).length,2);
 assert.equal((snippet.match(/private, no-store/g)??[]).length,2);
 assert.match(web,/userId:String\(selected\.id\)/);
 assert.match(web,/\["owner-page-visit-ranking",actorId,selected\?\.id/);
 assert.match(web,/كل المستخدمين/);
 assert.match(app,/path="\/page-visit-statistics" element=\{<Protected>\{user\?\.owner && !visitorOnly && !employeePreview/);
 assert.doesNotMatch(web,/method:"POST"|localStorage|recordId/);
});

test("analytics has one owner-only canonical public catalogue entry and fills dock by route, without self tracking",async()=>{
 const entry=pageByKey("public.page-visit-statistics");
 assert.ok(entry);
 assert.equal(entry.name,"إحصاءات زيارات الصفحات");
 assert.equal(entry.scope,"public");
 assert.equal(entry.type,"report");
 assert.equal(pageHref(entry,2),"/page-visit-statistics");
 assert.equal(pageKeyForLocation("/page-visit-statistics/","?unused=1"),entry.key);
 const user=(owner:boolean)=>({owner,kind:"admin"} as User);
 assert.equal(pageRuleAllows(entry.actions.view,user(true),null),true);
 assert.equal(pageRuleAllows(entry.actions.view,user(false),null),false);
 const file=(name:string)=>readFile(new URL("../apps/"+name,import.meta.url),"utf8");
 const [source,pages,guard]=await Promise.all(["web/src/App.tsx","api/src/services/pages.ts","web/src/page-directory.tsx"].map(file));
 assert.doesNotMatch(source,/<NavLink to="\/page-visit-statistics"/);
 assert.match(source,/PageRouteGuard pageKey="public.page-visit-statistics" trackVisit=\{false\}/);
 assert.match(source,/pageKeyForLocation\(location\.pathname,location\.search\)/);
 assert.match(pages,/"public.ai-tasks","public.page-visit-statistics"\]\.includes\(definition\.key\) \|\| user\.owner/);
 assert.match(guard,/if \(!trackVisit \|\| !user/);
});

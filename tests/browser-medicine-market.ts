import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { chromium, request, type APIRequestContext, type BrowserContext, type Page } from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { SessionResponse } from "../packages/contracts/src/index.ts";
import type { MarketCard, MarketDetail, MarketMeta } from "../packages/contracts/src/medicine-market.ts";

// Every identity/card/point in this test is disposable and isolated from production.
const databaseUrl=process.env.DATABASE_URL??DEFAULT_DATABASE_URL;
const schema=`browser_medicine_market_${process.pid}_${Date.now()}`;
const password="Medicine-market-browser-only-passphrase-2026";
const port=await new Promise<number>((resolve,reject)=>{
 const probe=createServer();probe.once("error",reject);probe.listen(0,"127.0.0.1",()=>{
  const address=probe.address();assert(address&&typeof address!=="string");probe.close(()=>resolve(address.port));
 });
});
const origin=`http://127.0.0.1:${port}`;
const runtime=await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:true});
const server=runtime.app.listen(port,"127.0.0.1");await once(server,"listening");
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",headless:true,args:["--no-sandbox"]});
const contexts:BrowserContext[]=[];const apiContexts:APIRequestContext[]=[];const errors:string[]=[];
let passed=0;
type Actor={api:APIRequestContext;session:SessionResponse};
async function actor(){const api=await request.newContext({baseURL:origin});apiContexts.push(api);return {api,session:{user:null,csrf:null}} as Actor;}
async function call<T>(actor:Actor,path:string,method="GET",body?:unknown){
 const response=await actor.api.fetch(`/api${path}`,{method,headers:{origin,...(actor.session.csrf?{"x-csrf-token":actor.session.csrf}:{})},...(body===undefined?{}:{data:body})});
 const value=await response.json();assert(response.ok(),`${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);return value as T;
}
async function pageFor(actor:Actor,mobile=false){
 const context=await browser.newContext({baseURL:origin,storageState:await actor.api.storageState(),viewport:mobile?{width:390,height:844}:{width:1440,height:960},isMobile:mobile,hasTouch:mobile});
 contexts.push(context);context.setDefaultTimeout(12000);const page=await context.newPage();
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(/cannot be a descendant|cannot contain a nested|same key/.test(m.text()))errors.push(m.text());});return page;
}
async function eventually(read:()=>Promise<boolean>){const until=Date.now()+10000;while(Date.now()<until){if(await read())return;await new Promise(r=>setTimeout(r,50));}assert.fail("Expected updated browser/API state");}
async function geometry(page:Page,width:number){const bounds=await page.evaluate(()=>({width:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth,direction:getComputedStyle(document.documentElement).direction}));assert.equal(bounds.direction,"rtl");assert.equal(bounds.width,width);assert(bounds.html<=width+1&&bounds.body<=width+1,JSON.stringify(bounds));}
async function createCard(page:Page,name:string,kind="medicine"){
 await page.getByRole("button",{name:"إضافة كرت",exact:true}).first().click();
 const dialog=page.getByRole("dialog",{name:"إضافة كرت إلى الدليل",exact:true});await dialog.waitFor();
 await dialog.getByLabel("نوع الكرت",{exact:true}).selectOption(kind);await dialog.getByLabel("اسم الكرت",{exact:true}).fill(name);
 await dialog.getByRole("button",{name:"إنشاء الكرت",exact:true}).click();await dialog.waitFor({state:"hidden"});
 await page.locator(".medicine-market-detail-heading").getByRole("heading",{name,exact:true}).waitFor();
 const id=Number(new URL(page.url()).searchParams.get("card"));assert(id>0);return id;
}
async function editText(page:Page,label:string,value:string){
 await page.getByRole("button",{name:new RegExp(`^(إضافة|تعديل) ${label}$`)}).click();
 const dialog=page.getByRole("dialog").filter({has:page.getByLabel(label,{exact:true})});await dialog.waitFor();
 await dialog.getByLabel(label,{exact:true}).fill(value);await dialog.getByRole("button",{name:"حفظ المساهمة",exact:true}).click();await dialog.waitFor({state:"hidden"});
}
function success(name:string){passed++;console.log(`PASS ${name}`);}
try{
 await mkdir("/workspace/scratch",{recursive:true});
 const anonymous=await actor(),owner=await actor(),member=await actor();
 const ownerUser=await provisionOwner(runtime.pool,{name:"مالك اختبار السوق",displayName:"مالك اختبار السوق",email:"market-owner@browser.test",password});
 owner.session=await call<SessionResponse>(owner,"/auth/login","POST",{email:ownerUser.email,password});
 member.session=await call<SessionResponse>(member,"/auth/register","POST",{name:"مساهم اختبار السوق",displayName:"مساهم اختبار السوق",email:"market-member@browser.test",phone:"",image:"",password});
 const publicPage=await pageFor(anonymous);await publicPage.goto("/medicine-market");
 await publicPage.getByRole("heading",{name:"سوق الأدوية",exact:true}).waitFor();await publicPage.getByRole("heading",{name:"نبدأ الدليل معًا",exact:true}).waitFor();
 assert.equal(await publicPage.getByRole("button",{name:"إضافة كرت",exact:true}).count(),0);await geometry(publicPage,1440);success("anonymous empty directory is public and has no write controls");

 const page=await pageFor(owner);await page.goto("/medicine-market");
 const medicineId=await createCard(page,"صنف اختبار المتصفح — عبوة 20 قرصًا");
 await editText(page,"اسم الصنف بالإنجليزي","Browser medicine package 20 tablets");
 await editText(page,"وصف العبوة","عبوة اختبار مؤقتة تحتوي شريطين، في كل شريط 10 أقراص.");
 await eventually(async()=>{const d=await call<MarketDetail>(owner,`/medicine-market/cards/${medicineId}`);return d.card.data.englishName==="Browser medicine package 20 tablets"&&typeof d.card.data.description==="string";});
 await editText(page,"سعر الشراء من الوكيل","1250");
 const beforePrice=await call<MarketDetail>(owner,`/medicine-market/cards/${medicineId}`);assert.equal(beforePrice.card.data.purchasePrice,undefined);assert(beforePrice.contributions.some(c=>c.fieldKey==="purchasePrice"&&c.status==="pending"));
 await page.getByRole("link",{name:"المصادقة",exact:true}).click();
 const priceReview=page.locator(".medicine-market-review-card").filter({has:page.getByRole("heading",{name:"سعر الشراء من الوكيل",exact:true})});await priceReview.waitFor();
 assert.match(await priceReview.innerText(),/اعتماد مساهمتك لا يمنحك نقاطًا/);await priceReview.getByRole("button",{name:"اعتماد",exact:true}).click();await priceReview.waitFor({state:"hidden"});
 const approvedPrice=await call<MarketDetail>(owner,`/medicine-market/cards/${medicineId}`);assert.equal(approvedPrice.card.data.purchasePrice,"1250");
 const ownerMeta=await call<MarketMeta>(owner,"/medicine-market/meta");assert.equal(ownerMeta.userPoints,"0");
 success("owner creates name-only card, edits fields, and explicitly approves pending price without self-points");

 await page.getByRole("link",{name:"نقاط الحقول",exact:true}).click();
 await page.getByLabel("نوع الكرت",{exact:true}).selectOption("medicine");
 const englishPolicy=page.locator(".medicine-market-policy-row").filter({has:page.locator("span").filter({hasText:/^اسم الصنف بالإنجليزي$/})});
 await englishPolicy.getByRole("button",{name:"ضبط",exact:true}).click();
 const policyDialog=page.getByRole("dialog",{name:"نقاط اسم الصنف بالإنجليزي",exact:true});await policyDialog.getByLabel("نقاط الإضافة",{exact:true}).fill("3");await policyDialog.getByLabel("نقاط التعديل",{exact:true}).fill("1");await policyDialog.getByRole("button",{name:"حفظ السياسة",exact:true}).click();await policyDialog.waitFor({state:"hidden"});
 const updatedMeta=await call<MarketMeta>(owner,"/medicine-market/meta");assert.equal(updatedMeta.types.find(t=>t.key==="medicine")?.fields.find(f=>f.key==="englishName")?.points.add,3);
 success("administration edits per-field add/edit point policy through dialog");

 const memberPage=await pageFor(member);await memberPage.goto("/medicine-market");const pendingId=await createCard(memberPage,"صنف مساهم اختبار المتصفح — عبوة مستقلة");
 const ownPending=await call<MarketDetail>(member,`/medicine-market/cards/${pendingId}`);assert.equal(ownPending.card.status,"pending");
 const notPublic=await anonymous.api.get(`/api/medicine-market/cards/${pendingId}`);assert.equal(notPublic.status(),404);
 assert.equal(await memberPage.getByRole("button",{name:/وزارة الصحة/}).count(),0);
 await memberPage.getByRole("link",{name:"مساهماتي",exact:true}).click();await memberPage.locator(".medicine-market-review-card").filter({hasText:"صنف مساهم اختبار المتصفح"}).waitFor();
 await page.goto("/medicine-market/review");const pendingReview=page.locator(".medicine-market-review-card").filter({has:page.getByRole("link",{name:"صنف مساهم اختبار المتصفح — عبوة مستقلة",exact:true})});await pendingReview.getByRole("button",{name:"اعتماد",exact:true}).click();await pendingReview.waitFor({state:"hidden"});
 const nowPublic=await call<MarketDetail>(anonymous,`/medicine-market/cards/${pendingId}`);assert.equal(nowPublic.card.status,"published");
 success("ordinary member card remains private until administrator reviews its name");

 await page.goto("/medicine-market");const pharmacyId=await createCard(page,"صيدلية اختبار المتصفح","pharmacy");
 await page.getByRole("button",{name:"إضافة أرقام المسؤولين",exact:true}).click();const contactsDialog=page.getByRole("dialog",{name:/أرقام المسؤولين/});
 await contactsDialog.getByRole("button",{name:"إضافة مسؤول ورقم",exact:true}).click();await contactsDialog.getByLabel("اسم المسؤول",{exact:true}).fill("مسؤول اختبار");await contactsDialog.getByLabel("الصفة",{exact:true}).fill("التواصل");await contactsDialog.getByLabel("رقم الهاتف",{exact:true}).fill("+967700000001");
 await contactsDialog.getByRole("button",{name:"حفظ المساهمة",exact:true}).click();await contactsDialog.waitFor({state:"hidden"});
 const contacts=await call<MarketDetail>(owner,`/medicine-market/cards/${pharmacyId}`);assert.equal((contacts.card.data.contacts as {phone:string}[])[0]?.phone,"+967700000001");await page.locator('a[href="tel:+967700000001"]').waitFor();
 success("structured contacts editor saves responsible person, role, phone and contact link");

 await page.goto("/medicine-market");await page.locator(".medicine-market-card").first().waitFor();await geometry(page,1440);await page.screenshot({path:"/workspace/scratch/medicine-market-desktop.png",fullPage:true});
 await call(owner,"/appearance","PATCH",{scope:"public",mode:"dark",color:"#176b61"});
 const mobile=await pageFor(owner,true);await mobile.goto(`/medicine-market?card=${pharmacyId}`);await mobile.locator('html[data-theme="dark"]').waitFor();await mobile.locator('a[href="tel:+967700000001"]').waitFor();await geometry(mobile,390);
 await mobile.screenshot({path:"/workspace/scratch/medicine-market-mobile.png",fullPage:true});
 await mobile.getByRole("button",{name:"تعديل أرقام المسؤولين",exact:true}).click();await mobile.getByRole("dialog",{name:/أرقام المسؤولين/}).waitFor();await geometry(mobile,390);await mobile.keyboard.press("Escape");await mobile.getByRole("dialog").waitFor({state:"hidden"});
 assert.equal(errors.length,0,errors.join("; "));success("desktop/mobile RTL, dark mode, dialog keyboard close and screenshots without page overflow or runtime errors");
}finally{
 for(const context of contexts)await context.close();await browser.close();for(const api of apiContexts)await api.dispose();
 await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();const cleanup=new Pool({connectionString:databaseUrl});try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}
}
console.log(`Medicine market browser scenarios: ${passed} passed`);

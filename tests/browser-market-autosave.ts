import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

// All API calls in this browser regression are intercepted locally. No live data.
const root = resolve("apps/web");
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {SessionProvider,useSession,api} from './src/api';
import {MarketInlineField} from './src/pages/MedicineMarketPage';
import {marketTypes} from '../../packages/contracts/src/medicine-market';
function Fixture(){
 const {user}=useSession();
 const key=new URLSearchParams(location.search).get('field');
 const detail=useQuery({queryKey:['medicine-market',user?.id,'card',101],queryFn:()=>api('/medicine-market/cards/101'),enabled:!!user});
 if(!user||!detail.data)return <p>Loading</p>;
 const card=detail.data.card;
 const field=marketTypes.find(t=>t.key===card.kind).fields.find(f=>f.key===key);
 return <><MarketInlineField card={card} field={{...field,points:{add:0,edit:0},policyRevision:0}}
   references={[{kind:'city',code:'test-city',name:'مدينة الاختبار',parentCode:null}]}
   canEdit={true} disabled={false} onOpen={()=>{}}/>
   <button id='outside' type='button'>خارج الحقل</button></>;
}
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter><SessionProvider><Fixture/></SessionProvider></BrowserRouter></QueryClientProvider>);
`;
await writeFile(resolve(root,"autosave-test.html"),`<!doctype html><html><body><div id="root"></div><script type="module" src="/autosave-test.tsx"></script></body></html>`);
await writeFile(resolve(root,"autosave-test.tsx"),fixture);
const vite=await createServer({configFile:resolve("apps/web/vite.config.ts"),server:{host:"127.0.0.1",port:0}});
await vite.listen();
const address=vite.httpServer!.address();
assert.ok(address&&typeof address!=="string");
const testOrigin=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let i=0;i<250;i++){if(check())return;await pause(20);}assert.ok(check(),"Expected auto-save did not occur");}
async function setup(field:string,kind:string,data:Record<string,unknown>={},pending=false){
 const page=await browser.newPage();
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 const card={id:101,kind,name:"كرت الاختبار",data,status:"published",archived:false,revision:1,createdBy:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),likes:0,ratingCount:0,ratingAverage:null,myLiked:false,myRating:null};
 const calls:Record<string,any>[]=[];
 let failNext=false,uploadFail=false,uploads=0;
 await page.route("**/api/**",async route=>{
   const req=route.request(),url=new URL(req.url());
   const send=(json:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(json)});
   if(url.pathname==="/api/auth/session")return send({user:{id:1,displayName:"اختبار محلي",kind:"admin",owner:true,archived:false,suspended:false,editor:true,monitor:true},csrf:"local-test"});
   if(url.pathname.endsWith("/images")&&req.method()==="POST"){
     uploads++;await pause(50);
     if(uploadFail)return send({error:{code:"image_error",message:"تعذر رفع الصورة"}},400);
     return send({url:"/api/medicine-market/images/11111111-1111-4111-8111-111111111111",bytes:100,width:1,height:1},201);
   }
   if(url.pathname.endsWith("/contributions")&&req.method()==="POST"){
     const body=req.postDataJSON();calls.push(body);await pause(30);
     if(failNext){failNext=false;return send({error:{code:"temporary",message:"تعذر الحفظ التجريبي"}},503);}
     const previous=body.fieldKey==="name"?card.name:(card.data[body.fieldKey]??null);
     if(JSON.stringify(previous)!==JSON.stringify(body.expectedValue))return send({error:{code:"conflict",message:"تغيرت القيمة؛ أعد فتح الحقل"}},409);
     if(body.fieldKey==="contacts"&&body.value.some((x:any)=>!x.name||!x.phone))return send({error:{code:"validation",message:"أكمل بيانات الاتصال"}},400);
     if(!pending){if(body.fieldKey==="name")card.name=body.value;else card.data[body.fieldKey]=body.value;card.revision++;}
     return send({card,contribution:{published:!pending,status:pending?"pending":"approved",value:body.value}},201);
   }
   if(url.pathname==="/api/medicine-market/cards/101")return send({card});
   if(url.pathname==="/api/medicine-market/cards")return send({items:[{...card,id:202,kind:url.searchParams.get("kind")||"agent",name:"اختيار الاختبار",data:{}}],total:1,page:1,pageSize:20});
   if(/\/cards\/\d+$/.test(url.pathname))return send({card:{...card,id:202,name:"اختيار الاختبار"}});
   return send({});
 });
 await page.goto(`${testOrigin}/autosave-test.html?field=${field}`);
 await page.locator(".medicine-market-field").waitFor();
 const edit=async()=>{
   await page.locator("button[title^='تعديل']").first().click();
   assert.equal(await page.getByRole("button",{name:"حفظ المساهمة",exact:true}).count(),0);
 };
 const outside=()=>page.locator("#outside").click();
 return {page,card,calls,edit,outside,uploads:()=>uploads,fail:()=>{failNext=true;},failUpload:()=>{uploadFail=true;},close:async()=>{assert.deepEqual(errors,[]);await page.close();}};
}
try{
 let t=await setup("name","agent");await t.edit();await t.page.getByLabel("الاسم",{exact:true}).fill("الاسم الجديد");await t.outside();await until(()=>t.card.name==="الاسم الجديد");assert.equal(t.calls.length,1);await t.close();
 t=await setup("address","agent");await t.edit();await t.page.locator("textarea").fill("عنوان\nمتعدد الأسطر");await t.outside();await until(()=>t.calls.length===1);await t.close();
 t=await setup("purchasePrice","medicine",{purchasePrice:"10"});await t.edit();await t.page.getByLabel("سعر الشراء من الوكيل",{exact:true}).fill("12.5");await t.page.getByLabel("سعر الشراء من الوكيل",{exact:true}).press("Enter");await until(()=>t.card.data.purchasePrice==="12.5");await t.outside();await pause(80);assert.equal(t.calls.length,1);await t.close();
 t=await setup("hasExpiry","composition",{hasExpiry:false});await t.edit();await t.page.getByRole("checkbox").check();await until(()=>t.card.data.hasExpiry===true);await t.close();
 t=await setup("cityCode","agent");await t.edit();await t.page.getByRole("combobox").selectOption("test-city");await until(()=>t.card.data.cityCode==="test-city");await t.close();
 t=await setup("agentId","medicine");await t.edit();await t.page.getByRole("combobox").fill("اختيار");await t.page.getByRole("option").first().click();await until(()=>t.card.data.agentId===202);assert.equal(t.calls.length,1);await t.close();
 t=await setup("contacts","agent",{contacts:[]});await t.edit();await t.page.getByRole("button",{name:"إضافة مسؤول ورقم"}).click();await t.page.getByLabel("اسم المسؤول",{exact:true}).fill("مسؤول اختبار");await t.page.getByLabel("رقم الهاتف",{exact:true}).fill("711111111");assert.equal(t.calls.length,0);await t.outside();await until(()=>t.calls.length===1);assert.equal(t.calls[0].value[0].phone,"711111111");await t.close();
 t=await setup("ingredients","composition",{ingredients:[{scientificId:202,strength:"10",unit:"mg"}]});await t.edit();await t.page.getByLabel("القوة",{exact:true}).fill("20");await t.outside();await until(()=>t.calls.length===1);assert.equal(t.calls[0].value[0].strength,"20");await t.close();
 t=await setup("accountingMappings","medicine",{accountingMappings:[{system:"نظام",identifier:"1"}]});await t.edit();await t.page.getByLabel("معرف الصنف في النظام",{exact:true}).fill("2");await t.outside();await until(()=>t.calls.length===1);await t.close();
 t=await setup("name","agent");await t.edit();t.fail();await t.page.getByLabel("الاسم",{exact:true}).fill("معاد الحفظ");await t.outside();await t.page.getByRole("button",{name:"إعادة المحاولة",exact:true}).waitFor();assert.equal(await t.page.getByLabel("الاسم",{exact:true}).inputValue(),"معاد الحفظ");await t.page.getByRole("button",{name:"إعادة المحاولة",exact:true}).click();await until(()=>t.card.name==="معاد الحفظ");assert.equal(t.calls[0].idempotencyKey,t.calls[1].idempotencyKey);await t.close();
 const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
 t=await setup("image","agent");await t.edit();await t.page.locator("input[type=file]").setInputFiles({name:"test.gif",mimeType:"image/gif",buffer:gif});await until(()=>!!t.card.data.image);assert.equal(t.uploads(),1);assert.equal(t.calls.length,1);await t.close();
 t=await setup("image","agent");await t.edit();t.failUpload();await t.page.locator("input[type=file]").setInputFiles({name:"test.gif",mimeType:"image/gif",buffer:gif});await t.page.locator(".image-upload-error").waitFor();assert.equal(t.calls.length,0);assert.equal(await t.page.locator("input[type=file]").count(),1);await t.close();
 t=await setup("name","agent",{},true);await t.edit();await t.page.getByLabel("الاسم",{exact:true}).fill("مقترح فقط");await t.outside();await t.page.getByText("تم إرسال المساهمة للمصادقة.",{exact:true}).waitFor();assert.equal(t.card.name,"كرت الاختبار");await t.close();
 t=await setup("prescriptionLines","prescription",{prescriptionLines:[{kind:"medicine",id:null}]});await t.edit();assert.equal(await t.page.getByRole("button",{name:"حفظ السطر",exact:true}).count(),0);await t.page.getByRole("combobox").fill("اختيار");await t.page.getByRole("option").first().click();await until(()=>t.calls.length===1);await t.page.getByRole("button",{name:"+ إضافة سطر",exact:true}).click();await until(()=>t.calls.length===2);await t.page.getByRole("button",{name:"− حذف السطر الأخير",exact:true}).click();await pause(100);assert.equal(t.calls.length,2,"Deletion must still require confirmation");await t.page.getByRole("button",{name:"تأكيد حذف السطر الأخير",exact:true}).click();await until(()=>t.calls.length===3);await t.close();
 console.log("MARKET_AUTOSAVE_BROWSER_OK: text, multiline, prices, checkbox, reference, relation, contacts, ingredients, mappings, retry, GIF upload, upload failure, moderation, prescription rows");
}finally{
 await browser.close();await vite.close();
 await rm(resolve(root,"autosave-test.html"),{force:true});await rm(resolve(root,"autosave-test.tsx"),{force:true});
}

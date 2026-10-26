import {readFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const root=new URL('../src/',import.meta.url);
const controller=readFileSync(new URL('routes-transaction-import.ts',root),'utf8');
const staging=readFileSync(new URL('routes-transaction-import-staging.ts',root),'utf8');
const helper=staging.slice(staging.indexOf('export function stagingPostingDate'),staging.indexOf('const sourceType'));
const derive=vm.runInNewContext(stripTypeScriptTypes(helper.replace('export ',''))+';stagingPostingDate');
const marker='}).strict().superRefine((batch, context) => {';
const start=controller.indexOf(marker);
assert(start>=0);
const end=controller.indexOf('\n});',start);
const callback=controller.slice(start+marker.length,end);
const refine=vm.runInNewContext(stripTypeScriptTypes('const refine=(batch,context)=>{'+callback+'};')+';refine');
function issues(preserve,dates,ids){
 const found=[];refine({postingDate:'2014-01-01',preserveDocumentDates:preserve,documents:dates.map((d,i)=>({type:'invoice',sourceId:ids?.[i]??String(i),payload:{documentDate:d}}))},{addIssue:x=>found.push(x)});return found;
}
test('legacy batches retain strict matching and common posting date',()=>{
 assert.equal(issues(undefined,['2014-01-01']).length,0);
 assert.equal(issues(false,['2014-01-02']).length,1);
 assert.equal(derive({postingDate:'2014-01-01'},{payload:{documentDate:'2014-01-02'}}),'2014-01-01');
});
test('explicit multi-date staging preserves each exact source day',()=>{
 assert.equal(issues(true,['2013-12-31','2014-01-02']).length,0);
 const input={postingDate:'2014-01-01',preserveDocumentDates:true};
 for(const d of ['2013-12-31','2014-01-02','2026-10-26'])assert.equal(derive(input,{payload:{documentDate:d}}),d);
});
test('duplicate source identities remain rejected in multi-date batches',()=>{
 assert.equal(issues(true,['2014-01-01','2014-01-02'],['x','x']).length,1);
});
test('database insertion uses each staged row date and retains immutable source hash',()=>{
 assert(staging.includes('posting_date:stagingPostingDate(input,doc)'));
 assert(staging.includes('COALESCE(r.posting_date::date,$3::date)'));
 assert(staging.includes('request_hash text,posting_date text)'));
 assert(staging.includes('request_hash:hash(doc)'));
 assert(controller.includes('if (doc.payload.documentDate !== value.postingDate)'));
 assert(controller.includes('preserveDocumentDates: z.boolean().optional()'));
});


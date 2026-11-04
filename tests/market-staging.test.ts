import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createMarketApp } from '../apps/api/src/market/app.ts';
import { signMarketRequest } from '../apps/api/src/market/transport.ts';
import type { User } from '../packages/contracts/src/index.ts';
import { loadStagingLines, stagingUrl } from '../apps/api/src/routes-market-staging.ts';
import { createMarketDatabase } from '../apps/api/src/market/database.ts';
test('staging downloads only exact transfer hosts without redirects or credentials',()=>{
 assert.equal(stagingUrl('https://sdmntprwest.oaiusercontent.com/files/abc-123/raw?sig=x'),true);
 for(const s of ['http://sdmntprwest.oaiusercontent.com/files/a/raw','https://127.0.0.1/files/a/raw','https://sdmntprwest.oaiusercontent.com.evil.com/files/a/raw','https://user:pass@sdmntprwest.oaiusercontent.com/files/a/raw','https://sdmntprwest.oaiusercontent.com:444/files/a/raw']) assert.equal(stagingUrl(s),false);
});
test('raw source integrity, exact decimals, rollback and duplicate protection',{skip:!process.env.MARKET_TEST_DATABASE_URL},async()=>{
 const schema='staging_test_'+randomUUID().replaceAll('-','');
 const pool=await createMarketDatabase(process.env.MARKET_TEST_DATABASE_URL!,schema);
 const db=await pool.connect(),job=randomUUID();
 const bytes=Buffer.from('original source');
 const lines=[{type:'source',key:'source',filename:'fixture.json',driveId:'fixture',modifiedAt:'2026-11-04',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,rowCount:1,metadata:{}},{type:'chunk',index:0,data:bytes.toString('base64')},{type:'row',section:'messages',position:1,payload:'{"id":9007199254740993,"price":1.234567890123456789}'},{type:'end'}];
 async function* input(values:unknown[]){for(const v of values)yield JSON.stringify(v);}
 try{
  await db.query("INSERT INTO market_import_jobs(id,bundle_sha256,actor_id,status) VALUES($1,$2,1,'running')",[job,'a'.repeat(64)]);
  await db.query('BEGIN');await loadStagingLines(db,job,input(lines));await db.query('COMMIT');
  const secret='staging-test-secret-'.repeat(4),app=createMarketApp(pool,secret),server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
   const address=server.address() as {port:number},path='/api/medicine-market/staging';
   const user={id:1,displayName:'Owner',kind:'admin',owner:true,archived:false,suspended:false,editor:false,monitor:false} as User;
   const read=async(u:User|null,signed=true)=>fetch('http://127.0.0.1:'+address.port+path,{headers:signed?signMarketRequest(secret,'GET',path,u,[],''):{}});
   assert.equal((await read(user,false)).status,401);
   assert.equal((await read({...user,owner:false})).status,403);
   assert.equal((await read(user)).status,200);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  const r=(await db.query("SELECT payload->>'id' id,payload->>'price' price FROM market_import_rows")).rows[0];
  assert.equal(r.id,'9007199254740993');assert.equal(r.price,'1.234567890123456789');
  assert.equal((await db.query('SELECT data FROM market_import_chunks')).rows[0].data.toString(),bytes.toString());
  const bad=[{...lines[0],key:'other',driveId:'other',sha256:'b'.repeat(64)},...lines.slice(1)];
  await db.query('BEGIN');await assert.rejects(loadStagingLines(db,job,input(bad)));await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int n FROM market_import_sources')).rows[0].n,1);
  await db.query('BEGIN');await assert.rejects(loadStagingLines(db,job,input(lines)));await db.query('ROLLBACK');
 }finally{db.release();await pool.end();const cleanup=new Pool({connectionString:process.env.MARKET_TEST_DATABASE_URL});try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}}
});

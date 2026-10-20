import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { inboxFilter } from "./notifications.ts";
import { permissionRuleEffects } from "./permission-rules.ts";

const publicKey=process.env.WEB_PUSH_PUBLIC_KEY??"";
const privateKey=process.env.WEB_PUSH_PRIVATE_KEY??"";
const publicBytes=Buffer.from(publicKey,"base64url");
const privateBytes=Buffer.from(privateKey,"base64url");
export const pushReady=publicBytes.length===65 && publicBytes[0]===4 && privateBytes.length===32;
export const pushPublicKey=pushReady?publicKey:null;
export const hashEndpoint=(endpoint:string)=>createHash("sha256").update(endpoint).digest("hex");

export function validPushEndpoint(endpoint:string):boolean {
  try{
    const u=new URL(endpoint);
    if(u.protocol!=="https:"||u.port||u.username||u.password||u.hash||endpoint.length>2048)return false;
    const host=u.hostname.toLowerCase();
    return host==="fcm.googleapis.com"||host==="fcm-xm.googleapis.com"||
      host==="updates.push.services.mozilla.com"||host==="web.push.apple.com"||
      host.endsWith(".push.apple.com")||host.endsWith(".push.services.mozilla.com")||
      host.endsWith(".notify.windows.com");
  }catch{return false;}
}
export function validPushKeys(p256dh:string,auth:string):boolean{
  if(!/^[A-Za-z0-9_-]+$/.test(p256dh)||!/^[A-Za-z0-9_-]+$/.test(auth))return false;
  const key=Buffer.from(p256dh,"base64url");
  const secret=Buffer.from(auth,"base64url");
  return key.length===65&&key[0]===4&&secret.length===16;
}
const vapidKey=pushReady?createPrivateKey({key:{
  kty:"EC",crv:"P-256",
  x:publicBytes.subarray(1,33).toString("base64url"),
  y:publicBytes.subarray(33).toString("base64url"),
  d:privateBytes.toString("base64url"),
},format:"jwk"}):null;
function jwt(endpoint:string,origin:string):string{
  if(!vapidKey)throw new Error("Web Push not configured");
  const b64=(v:object)=>Buffer.from(JSON.stringify(v)).toString("base64url");
  const input=b64({typ:"JWT",alg:"ES256"})+"."+
    b64({aud:new URL(endpoint).origin,sub:origin,exp:Math.floor(Date.now()/1000)+3600});
  return input+"."+sign("sha256",Buffer.from(input),{
    key:vapidKey,dsaEncoding:"ieee-p1363",
  }).toString("base64url");
}
// RFC8291 WebPush HKDF: auth secret -> IKM -> aes128gcm content key and nonce.
export function encryptPayload(p256dh:string,auth:string,payload:object):Buffer{
  if(!validPushKeys(p256dh,auth))throw new Error("Invalid subscription keys");
  const receiver=Buffer.from(p256dh,"base64url");
  const sender=createECDH("prime256v1");
  const senderPublic=sender.generateKeys();
  const shared=sender.computeSecret(receiver);
  const ikm=Buffer.from(hkdfSync("sha256",shared,Buffer.from(auth,"base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"),receiver,senderPublic]),32));
  const salt=randomBytes(16);
  const key=Buffer.from(hkdfSync("sha256",ikm,salt,Buffer.from("Content-Encoding: aes128gcm\0"),16));
  const nonce=Buffer.from(hkdfSync("sha256",ikm,salt,Buffer.from("Content-Encoding: nonce\0"),12));
  const clear=Buffer.concat([Buffer.from(JSON.stringify(payload)),Buffer.from([2])]);
  if(clear.length+16>4096)throw new Error("Web Push payload too long");
  const cipher=createCipheriv("aes-128-gcm",key,nonce);
  const encrypted=Buffer.concat([cipher.update(clear),cipher.final(),cipher.getAuthTag()]);
  const header=Buffer.alloc(5);header.writeUInt32BE(4096,0);header[4]=senderPublic.length;
  return Buffer.concat([salt,header,senderPublic,encrypted]);
}
interface NotificationMessage{
  endpoint:string;p256dh:string;auth:string;title:string;message:string;
  href:string|null;company_id:number|null;notification_id:number;
}
async function send(input:NotificationMessage,origin:string):Promise<number>{
  if(!pushReady||!validPushEndpoint(input.endpoint))throw new Error("Invalid push endpoint");
  const url=input.href?.startsWith("/")&&!input.href.startsWith("//")
    ?input.href:input.company_id?"/companies/"+input.company_id+"/notifications":"/notifications";
  const body=encryptPayload(input.p256dh,input.auth,{
    title:input.title.slice(0,100),body:input.message.slice(0,180),url,id:input.notification_id,
  });
  const response=await fetch(input.endpoint,{
    method:"POST",
    headers:{
      Authorization:"vapid t="+jwt(input.endpoint,origin)+", k="+publicKey,
      TTL:"3600",Urgency:"normal",
      "Content-Encoding":"aes128gcm","Content-Type":"application/octet-stream",
    },
    body:new Uint8Array(body),signal:AbortSignal.timeout(9000),
  });
  return response.status;
}
interface Queued extends NotificationMessage{
  id:string;subscription_id:string;user_id:number;employee_id:number|null;
  general:boolean;attempts:number;
}
async function deliver(client:PoolClient,origin:string):Promise<boolean>{
  const pending=await client.query<Queued>(
    "SELECT d.id,d.subscription_id,d.attempts,d.notification_id,"+
    " p.endpoint,p.p256dh,p.auth,p.user_id,n.title,n.message,n.href,n.company_id,"+
    " e.id AS employee_id,(u.owner OR COALESCE(e.is_general_manager,false)) AS general"+
    " FROM web_push_deliveries d"+
    " JOIN web_push_subscriptions p ON p.id=d.subscription_id"+
    " JOIN notifications n ON n.id=d.notification_id AND n.recipient_user_id=p.user_id"+
    " JOIN users u ON u.id=p.user_id AND NOT u.archived"+
    " JOIN sessions ss ON ss.token_hash=p.session_hash AND ss.user_id=p.user_id"+
    "  AND ss.expires_at>clock_timestamp()"+
    " LEFT JOIN employees e ON e.user_id=p.user_id AND e.company_id=n.company_id AND e.active"+
    " WHERE d.delivered_at IS NULL AND d.cancelled_at IS NULL"+
    " AND d.next_attempt_at<=clock_timestamp()"+
    " ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED");
  const row=pending.rows[0];if(!row)return false;
  const allowed=await client.query(
    "SELECT 1 FROM notifications n JOIN notification_templates t ON t.code=n.code"+
    " LEFT JOIN notification_settings s ON s.company_id IS NOT DISTINCT FROM n.company_id AND s.code=n.code"+
    " WHERE n.id=$5 AND n.read_at IS NULL AND n.completed_at IS NULL"+
    " AND (n.snoozed_until IS NULL OR n.snoozed_until<=clock_timestamp())"+
    " AND COALESCE(s.enabled,t.implemented)"+
    " AND (n.company_id IS NULL OR $4::boolean OR $3::integer IS NOT NULL)"+
    " AND "+inboxFilter,
    [row.user_id,row.company_id,row.employee_id,row.general,row.notification_id]);
  const setting=await client.query<{disabled:boolean}>(
    "SELECT EXISTS(SELECT 1 FROM page_settings pg WHERE pg.page_key=$1"+
    " AND (pg.company_id IS NULL OR pg.company_id=$2) AND pg.enabled=false) AS disabled",
    [row.company_id===null?"public.notifications":"company.notifications",row.company_id]);
  const denied=row.company_id!==null && row.employee_id!==null && !row.general &&
    (await permissionRuleEffects(client,row.company_id,row.employee_id))
      .get("company.notifications:view")==="deny";
  if(!allowed.rowCount || setting.rows[0]?.disabled || denied){
    await client.query("UPDATE web_push_deliveries SET cancelled_at=clock_timestamp() WHERE id=$1",[row.id]);
    return true;
  }
  let status:number|null=null;
  try{
    status=await send(row,origin);
    if(status===404||status===410){
      await client.query("DELETE FROM web_push_subscriptions WHERE id=$1",[row.subscription_id]);
      return true;
    }
  }catch(err){
    console.warn("Push retry:",err instanceof Error?err.name:"unknown");
  }
  const good=status!==null&&status>=200&&status<300;
  const discard=(status!==null&&status>=400&&status<500)||row.attempts>=4;
  await client.query(
    "UPDATE web_push_deliveries SET attempts=attempts+1,last_status=$2,"+
    " delivered_at=CASE WHEN $3 THEN clock_timestamp() ELSE delivered_at END,"+
    " cancelled_at=CASE WHEN $4 THEN clock_timestamp() ELSE cancelled_at END,"+
    " next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,6)))::integer)"+
    " WHERE id=$1",
    [row.id,status,good,discard]);
  return true;
}
async function scan(pool:Pool,origin:string):Promise<void>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const lock=await client.query<{ok:boolean}>(
      "SELECT pg_try_advisory_xact_lock(hashtext('alraesy-web-push')) AS ok");
    if(!lock.rows[0]?.ok){await client.query("ROLLBACK");return;}
    await client.query(
      "INSERT INTO web_push_deliveries(notification_id,subscription_id)"+
      " SELECT n.id,p.id FROM notifications n"+
      " JOIN web_push_subscriptions p ON p.user_id=n.recipient_user_id"+
      " JOIN users u ON u.id=p.user_id AND NOT u.archived"+
      " JOIN sessions ss ON ss.token_hash=p.session_hash AND ss.user_id=p.user_id"+
      " AND ss.expires_at>clock_timestamp()"+
      " WHERE n.created_at>=p.created_at AND n.read_at IS NULL AND n.completed_at IS NULL"+
      " AND NOT EXISTS(SELECT 1 FROM web_push_deliveries d WHERE d.notification_id=n.id AND d.subscription_id=p.id)"+
      " ORDER BY n.created_at DESC LIMIT 300 ON CONFLICT DO NOTHING");
    for(let i=0;i<8;i++)if(!(await deliver(client,origin)))break;
    await client.query("COMMIT");
  }catch(err){
    await client.query("ROLLBACK").catch(()=>{});
    console.warn("Push scan:",err instanceof Error?err.message:"unknown");
  }finally{client.release();}
}
export function startPushNotifications(pool:Pool,origin:string):()=>Promise<void>{
  if(!pushReady){
    console.warn("Web Push disabled until VAPID keys are configured");
    return async()=>{};
  }
  let stopped=false;let running:Promise<void>|null=null;
  const tick=()=>{
    if(stopped||running)return;
    running=scan(pool,origin).finally(()=>{running=null;});
  };
  const timer=setInterval(tick,15000);timer.unref();tick();
  return async()=>{stopped=true;clearInterval(timer);await running;};
}

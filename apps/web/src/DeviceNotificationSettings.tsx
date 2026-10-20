import { useEffect, useState } from "react";
import { api, useSession } from "./api";
import { Button, Card, Notice } from "./ui";
import { denialReminderDue } from "./push-permission-policy";

type Config={enabled:boolean;publicKey:string|null};
type Status="loading"|"unsupported"|"ios-install"|"disabled"|"blocked"|"active"|"available";
function vapidBytes(text:string):Uint8Array<ArrayBuffer>{
  const raw=atob(text.replace(/-/g,"+").replace(/_/g,"/")+
    "=".repeat((4-text.length%4)%4));
  const result=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)result[i]=raw.charCodeAt(i);
  return result;
}
export function supported():boolean{
  return "serviceWorker" in navigator && "PushManager" in window &&
    "Notification" in window && window.isSecureContext;
}
export function onApplePhone():boolean{
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
export function iosInstalled():boolean{
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & {standalone?:boolean}).standalone===true;
}
export const pushOptOutKey=(userId:number)=>"alraesy-push-disabled:"+userId;
export const pushDeniedKey=(userId:number)=>"alraesy-push-denied-at:"+userId;
export async function subscribeDevice(publicKey:string):Promise<void>{
  if(!supported())throw new Error("هذا المتصفح لا يدعم إشعارات الويب.");
  const reg=await navigator.serviceWorker.register("/push-sw.js",{scope:"/"});
  await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({
    userVisibleOnly:true,applicationServerKey:vapidBytes(publicKey),
  });
  const keys=sub.toJSON().keys;
  if(!keys?.p256dh||!keys.auth)throw new Error("لم تُرجع خدمة الجهاز مفاتيح الاشتراك.");
  await api("/push/subscribe",{
    method:"POST",
    body:{endpoint:sub.endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}},
  });
}
type PromptMode="request"|"blocked"|null;

/** Display an immediate opt-in invitation at login, without a browser
 * permission request until the user explicitly clicks the button. Denial
 * reminders are in-page only and occur at most once every three days. */
export function DevicePushBootstrap({userId}:{userId:number}){
  const [config,setConfig]=useState<Config|null>(null);
  const [mode,setMode]=useState<PromptMode>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    let mounted=true;
    (async()=>{
      try{
        const cfg=await api<Config>("/push/config");
        if(!mounted||!cfg.enabled||!cfg.publicKey||!supported()||
          (onApplePhone()&&!iosInstalled()))return;
        setConfig(cfg);
        // An explicit opt-out from "حسابي" always overrides default-on.
        if(localStorage.getItem(pushOptOutKey(userId))==="1")return;
        if(Notification.permission==="granted"){
          await subscribeDevice(cfg.publicKey);
          return;
        }
        if(Notification.permission==="default"){
          if(mounted)setMode("request");
          return;
        }
        if(Notification.permission==="denied"){
          const key=pushDeniedKey(userId);
          const now=Date.now();
          const prior=Number(localStorage.getItem(key));
          if(!Number.isFinite(prior)||prior<=0){
            localStorage.setItem(key,String(now));
          }else if(denialReminderDue(prior,now)){
            localStorage.setItem(key,String(now));
            if(mounted)setMode("blocked");
          }
        }
      }catch{
        // User may be signed out or offline; do not interrupt navigation.
      }
    })();
    return()=>{mounted=false;};
  },[userId]);
  async function allow(){
    if(!config?.publicKey||busy)return;
    setBusy(true);setError("");
    try{
      // Browser permission dialogs must happen from a direct user gesture.
      const permission=await Notification.requestPermission();
      if(permission==="granted"){
        await subscribeDevice(config.publicKey);
        localStorage.removeItem(pushOptOutKey(userId));
        localStorage.removeItem(pushDeniedKey(userId));
        setMode(null);
      }else if(permission==="denied"){
        localStorage.setItem(pushDeniedKey(userId),String(Date.now()));
        setMode(null);
      }else{
        setMode(null);
      }
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر تفعيل الإشعارات");
    }finally{setBusy(false);}
  }
  function recheck(){
    if(Notification.permission==="granted"){
      if(config?.publicKey){
        setBusy(true);setError("");
        void subscribeDevice(config.publicKey).then(()=>{
          localStorage.removeItem(pushDeniedKey(userId));
          setMode(null);
        }).catch(cause=>{
          setError(cause instanceof Error?cause.message:"تعذر تفعيل الإشعارات");
        }).finally(()=>setBusy(false));
      }
    }else{
      // Do not invoke requestPermission while blocked: browsers will reject
      // repeated requests until the user changes site/OS permission settings.
      setError("غيّر إذن الإشعارات من إعدادات Chrome أو إعدادات إشعارات التطبيق في الهاتف أولًا.");
    }
  }
  if(!mode)return null;
  return <div className="device-push-invite" role="region" aria-label="إشعارات الجهاز">
    <strong>{mode==="blocked"?"تذكير بإشعارات الجهاز":"تفعيل إشعارات الرئيسي"}</strong>
    <span>{mode==="blocked"
      ?"كنت قد منعت إشعارات الجهاز. يمكنك السماح بها من إعدادات المتصفح أو الهاتف؛ لن يتكرر هذا التذكير قبل 3 أيام."
      :"اسمح بإشعارات الجهاز لتصلك التنبيهات الجديدة حتى عندما تكون الصفحة مغلقة."}</span>
    {error&&<span role="alert">{error}</span>}
    <div className="device-push-invite-actions">
      {mode==="request"
        ?<Button size="compact" disabled={busy} onClick={()=>void allow()}>
          {busy?"جارٍ التفعيل…":"تفعيل الإشعارات"}
         </Button>
        :<Button size="compact" disabled={busy} onClick={recheck}>
          {busy?"جارٍ التحقق…":"تحقّق من السماح"}
         </Button>}
      <Button size="compact" variant="secondary" onClick={()=>setMode(null)}>
        لاحقًا
      </Button>
    </div>
  </div>;
}

export function DeviceNotificationSettings(){
  const {user}=useSession();
  const [config,setConfig]=useState<Config|null>(null);
  const [state,setState]=useState<Status>("loading");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const [testBusy,setTestBusy]=useState(false);
  const [testResult,setTestResult]=useState("");
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        const info=await api<Config>("/push/config");
        if(!alive)return;
        setConfig(info);
        if(!info.enabled){setState("disabled");return;}
        if(!supported()){setState("unsupported");return;}
        if(onApplePhone()&&!iosInstalled()){setState("ios-install");return;}
        if(Notification.permission==="denied"){setState("blocked");return;}
        const reg=await navigator.serviceWorker.getRegistration("/");
        const subscription=await reg?.pushManager.getSubscription();
        const active=await api<{devices:number}>("/push/status");
        if(alive)setState(subscription&&active.devices>0?"active":"available");
      }catch(cause){
        if(alive){setState("unsupported");
          setError(cause instanceof Error?cause.message:"تعذر معرفة حالة الإشعارات");}
      }
    })();
    return()=>{alive=false;};
  },[]);
  async function enable(){
    if(busy||!config?.publicKey||!supported())return;
    // The OS permission prompt must be requested directly from a user click.
    const permission=await Notification.requestPermission();
    if(permission!=="granted"){
      if(permission==="denied"&&user)localStorage.setItem(pushDeniedKey(user.id),String(Date.now()));
      setState(permission==="denied"?"blocked":"available");
      return;
    }
    setBusy(true);setError("");setMessage("");
    try{
      await subscribeDevice(config.publicKey);
      if(user){
        localStorage.removeItem(pushOptOutKey(user.id));
        localStorage.removeItem(pushDeniedKey(user.id));
      }
      setState("active");
      setMessage("تم تفعيل إشعارات هذا الجهاز. ستصلك التنبيهات الجديدة حتى عند إغلاق الصفحة، إذا سمح النظام بإشعارات الخلفية.");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر تشغيل إشعارات الجهاز");
    }finally{setBusy(false);}
  }
  async function disable(){
    if(busy||!supported())return;
    setBusy(true);setError("");setMessage("");
    try{
      const reg=await navigator.serviceWorker.getRegistration("/");
      const sub=await reg?.pushManager.getSubscription();
      if(sub){
        await api("/push/unsubscribe",{
          method:"POST",body:{endpoint:sub.endpoint},
        });
        await sub.unsubscribe();
      }
      if(user)localStorage.setItem(pushOptOutKey(user.id),"1");
      setState(Notification.permission==="denied"?"blocked":"available");
      setMessage("تم إيقاف إشعارات هذا الجهاز. يمكنك إعادة تفعيلها من هنا.");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر إلغاء الاشتراك");
    }finally{setBusy(false);}
  }
  async function testNotification(){
    if(testBusy || !supported() || Notification.permission!=="granted")return;
    setTestBusy(true);setTestResult("");setError("");
    try{
      const reg=await navigator.serviceWorker.register("/push-sw.js",{scope:"/"});
      await reg.showNotification("تجربة إشعار من الرئيسي",{
        body:"هذا إشعار تجريبي لتفقد ظهور التنبيه العائم والصوت على جهازك.",
        icon:"/site-icon.png",badge:"/site-icon.png",tag:"alraesy-notification-test",
        silent:false,
        vibrate:[200,100,200],
      } as NotificationOptions & {vibrate:number[]});
      setTestResult("أرسلنا إشعارًا تجريبيًا إلى هذا الجهاز. إن وصل بصمت، راجع إعدادات التنبيهات والصوت أسفل الصفحة.");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر إرسال الإشعار التجريبي.");
    }finally{setTestBusy(false);}
  }
  const description:Record<Status,string>={
    loading:"جارٍ فحص دعم الإشعارات…",
    disabled:"خدمة الإشعارات غير مهيأة في الخادم حاليًا.",
    unsupported:"هذا المتصفح لا يدعم إشعارات الويب، أو الموقع ليس على اتصال HTTPS.",
    "ios-install":"على iPhone، أضف الموقع إلى الشاشة الرئيسية من Safari وافتح التطبيق المثبت لتفعيل الإشعارات.",
    blocked:"الإشعارات محظورة من إعدادات المتصفح أو الجهاز. اسمح بإشعارات هذا الموقع من الإعدادات ثم أعد فتح الصفحة.",
    active:"الإشعارات مفعلة على هذا الجهاز.",
    available:"الإشعارات مفعلة افتراضيًا في الموقع؛ اسمح بها على هذا الجهاز ليتم استقبالها في الخلفية.",
  };
  return <Card title="إشعارات الجهاز">
    <p className="muted">{description[state]}</p>
    {error&&<Notice tone="error">{error}</Notice>}
    {message&&<Notice tone="success">{message}</Notice>}
    <div className="form-actions">
      {state==="available"&&
        <Button disabled={busy||!config?.publicKey} onClick={()=>void enable()}>
          {busy?"جارٍ التفعيل…":"تفعيل إشعارات الجهاز"}
        </Button>}
      {state==="active"&&
        <Button variant="secondary" disabled={busy} onClick={()=>void disable()}>
          {busy?"جارٍ الإيقاف…":"إيقاف إشعارات هذا الجهاز"}
        </Button>}
    </div>
    {state==="active" && <div className="form-actions">
      <Button variant="secondary" disabled={testBusy} onClick={()=>void testNotification()}>
        {testBusy?"جارٍ الإرسال…":"تجربة إشعار على هذا الجهاز"}
      </Button>
      {testResult&&<Notice tone="success">{testResult}</Notice>}
    </div>}
    <details className="notification-device-help">
      <summary>الإشعارات تصل بصمت؟ طريقة تشغيل التنبيه والصوت من إعدادات الهاتف</summary>
      {onApplePhone()?(
        <p>على iPhone: افتح <strong>الإعدادات ← الإشعارات ← الرئيسي (Alraesy)</strong>، ثم فعّل «السماح بالإشعارات» و«الأصوات» و«اللافتات». تأكد أيضًا من عدم تشغيل وضع التركيز الذي يكتم التنبيهات. يجب فتح التطبيق المثبّت من الشاشة الرئيسية.</p>
      ):(
        <p>على Android: اضغط مطولًا على أيقونة التطبيق ثم افتح <strong>معلومات التطبيق ← الإشعارات</strong>، وفعّل الإشعارات والصوت و«الظهور على الشاشة/التنبيه العائم» إن كانت متاحة. إن كنت تستخدم Chrome دون تثبيت الموقع فافتح إعدادات Chrome ثم «إعدادات المواقع ← الإشعارات»، وتحقق أيضًا من إعدادات إشعارات Chrome في الهاتف. أوقف وضع «عدم الإزعاج» إذا كنت تريد الصوت.</p>
      )}
      <p className="muted">لا يمكن للموقع تشغيل الصوت أو اللافتات من تلقاء نفسه؛ تعتمد طريقة ظهور الإشعار على طراز الهاتف وإعدادات النظام.</p>
    </details>
    <small className="muted">إشعارات الموقع مفعّلة افتراضيًا، وموافقة المتصفح مستقلة لكل هاتف وكمبيوتر. يمكنك إيقافها هنا في أي وقت.</small>
  </Card>;
}

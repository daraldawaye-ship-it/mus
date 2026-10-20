import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Notice } from "./ui";

type Config={enabled:boolean;publicKey:string|null};
type Status="loading"|"unsupported"|"ios-install"|"disabled"|"blocked"|"active"|"available";
function vapidBytes(text:string):Uint8Array<ArrayBuffer>{
  const raw=atob(text.replace(/-/g,"+").replace(/_/g,"/")+
    "=".repeat((4-text.length%4)%4));
  const result=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)result[i]=raw.charCodeAt(i);
  return result;
}
function supported():boolean{
  return "serviceWorker" in navigator && "PushManager" in window &&
    "Notification" in window && window.isSecureContext;
}
function onApplePhone():boolean{
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function iosInstalled():boolean{
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & {standalone?:boolean}).standalone===true;
}
export function DeviceNotificationSettings(){
  const [config,setConfig]=useState<Config|null>(null);
  const [state,setState]=useState<Status>("loading");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
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
        if(alive)setState(subscription?"active":"available");
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
      setState(permission==="denied"?"blocked":"available");
      return;
    }
    setBusy(true);setError("");setMessage("");
    try{
      const reg=await navigator.serviceWorker.register("/push-sw.js",{scope:"/"});
      await navigator.serviceWorker.ready;
      let sub=await reg.pushManager.getSubscription();
      if(!sub)sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:vapidBytes(config.publicKey),
      });
      const keys=sub.toJSON().keys;
      if(!keys?.p256dh||!keys.auth)throw new Error("لم تُرجع خدمة الهاتف مفاتيح الاشتراك");
      await api("/push/subscribe",{
        method:"POST",
        body:{endpoint:sub.endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}},
      });
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
      setState(Notification.permission==="denied"?"blocked":"available");
      setMessage("تم إيقاف إشعارات هذا الجهاز.");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر إلغاء الاشتراك");
    }finally{setBusy(false);}
  }
  const description:Record<Status,string>={
    loading:"جارٍ فحص دعم الإشعارات…",
    disabled:"خدمة الإشعارات غير مهيأة في الخادم حاليًا.",
    unsupported:"هذا المتصفح لا يدعم إشعارات الويب، أو الموقع ليس على اتصال HTTPS.",
    "ios-install":"على iPhone، أضف الموقع إلى الشاشة الرئيسية من Safari وافتح التطبيق المثبت لتفعيل الإشعارات.",
    blocked:"الإشعارات محظورة من إعدادات المتصفح أو الجهاز. اسمح بإشعارات هذا الموقع من الإعدادات ثم أعد فتح الصفحة.",
    active:"الإشعارات مفعلة على هذا الجهاز.",
    available:"يمكنك تفعيل الإشعارات على هذا الجهاز لتصلك تنبيهات الموقع حتى عند إغلاقه.",
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
    <small className="muted">التفعيل اختياري لكل هاتف أو كمبيوتر بشكل مستقل، ولا يغيّر إعدادات الإشعارات داخل الموقع.</small>
  </Card>;
}

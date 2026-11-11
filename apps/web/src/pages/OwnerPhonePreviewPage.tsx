import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MonitorSmartphone, RotateCcw, ExternalLink } from "lucide-react";
import { useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

const sizes = [360, 390, 430, 768];
const links = [
  { path: "/medicine-market", label: "السوق الرئيسي" },
  { path: "/", label: "الصفحة الرئيسية" },
  { path: "/companies/2", label: "صيدلية دار الدواء" },
  { path: "/pages", label: "قائمة الصفحات" },
  { path: "/notifications", label: "الإشعارات" },
];
function safePath(input: string): string | null {
  const path = input.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) return null;
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin && url.pathname !== "/owner-phone-preview"
      ? url.pathname + url.search + url.hash : null;
  } catch { return null; }
}
export default function OwnerPhonePreviewPage() {
  const { user } = useSession();
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(430);
  const [height, setHeight] = useState(780);
  const [address, setAddress] = useState("/medicine-market");
  const [current, setCurrent] = useState("/medicine-market");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  if (!user?.owner) return <Notice tone="warning">هذه المعاينة خاصة بمالك الموقع فقط.</Notice>;
  function navigate(path: string) {
    const safe = safePath(path);
    if (!safe) { setError("أدخل مسارًا داخليًا صحيحًا يبدأ بـ / وليس صفحة المعاينة نفسها."); return; }
    setError("");
    setCurrent(safe);
    setAddress(safe);
    if (frame.current) frame.current.src = safe;
  }
  function sync() {
    try {
      const location = frame.current?.contentWindow?.location;
      if (!location || location.origin !== window.location.origin) return;
      const path = location.pathname + location.search + location.hash;
      setCurrent(path);
      setAddress(path);
    } catch { setError("تعذر قراءة عنوان الصفحة المعروضة."); }
  }
  function openWindow() {
    const url = safePath(current) ?? "/medicine-market";
    const popup = window.open(url, "alraesy-owner-phone", "popup=yes,width=" + (width+20) +
      ",height=" + (height+90) + ",resizable=yes,scrollbars=yes");
    if (popup) popup.focus();
    else setError("منع المتصفح النافذة الجديدة؛ اسمح بالنوافذ المنبثقة أو استخدم المعاينة هنا.");
  }
  return <>
    <PageHeader title="معاينة الموقع بهيئة الهاتف — للمالك"
      description="شاشة هاتف حقيقية لعرض السوق الرئيسي والموقع كاملًا من اللابتوب." />
    <Card title="خيارات المعاينة">
      <div className="owner-phone-controls">
        <label>عرض الشاشة
          <select value={width} onChange={e=>setWidth(Number(e.target.value))}>
            {sizes.map(size=><option key={size} value={size}>{size} بكسل</option>)}
          </select>
        </label>
        <label>ارتفاع الشاشة
          <select value={height} onChange={e=>setHeight(Number(e.target.value))}>
            {[640,780,850,950].map(size=><option key={size} value={size}>{size} بكسل</option>)}
          </select>
        </label>
        <label>انتقال سريع
          <select value={links.some(item=>item.path===current)?current:""}
            onChange={e=>e.target.value&&navigate(e.target.value)}>
            <option value="">اختر الصفحة</option>
            {links.map(item=><option key={item.path} value={item.path}>{item.label}</option>)}
          </select>
        </label>
        <form onSubmit={e=>{e.preventDefault();navigate(address);}}>
          <label htmlFor="owner-phone-address">رابط أي صفحة من الموقع</label>
          <div className="owner-phone-address">
            <input id="owner-phone-address" dir="ltr" value={address}
              onChange={e=>setAddress(e.target.value)} />
            <Button type="submit" size="compact">فتح</Button>
          </div>
        </form>
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={()=>setRefresh(value=>value+1)}>
          <RotateCcw size={16}/> تحديث
        </Button>
        <Button variant="secondary" onClick={openWindow}>
          <ExternalLink size={16}/> نافذة هاتف مستقلة
        </Button>
        <Link className="button button-secondary" to={safePath(current)??"/medicine-market"}>العرض العادي</Link>
      </div>
      {error&&<Notice tone="warning">{error}</Notice>}
      <p className="muted">هذه صفحات الموقع الفعلية وليست نسخة تجريبية. أي إضافة أو تعديل أو حذف أو ترحيل داخل المعاينة سيُحفظ فعليًا بصلاحيات حسابك.</p>
    </Card>
    <div className="owner-phone-stage" dir="ltr">
      <div className="owner-phone-device" style={{width:width+16}}>
        <div className="owner-phone-device-top"><MonitorSmartphone size={17}/> الرئيسي — {width} px</div>
        <iframe title="الموقع بعرض الهاتف" ref={frame} src={current} key={refresh}
          onLoad={sync} style={{width,height}}/>
        <div className="owner-phone-device-bottom"><span/></div>
      </div>
    </div>
  </>;
}

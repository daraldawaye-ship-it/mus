import { useRef, useState, type FormEvent } from "react";
import { api, useSession } from "./api";
import { Button, Dialog, Notice } from "./ui";

const categories = [
  "مستخدم","دكتور جامعه","طبيب","طالب صيدليه","صيدلي",
  "صيدلي موظف في صيدليه","مالك صيدليه","مندوب شركه","متحصل شركه",
  "سوبر فايزر شركة","مالك شركة - وكيل","مالك محل جمله",
  "موظف في محل جمله","موزع ادويه - شخصي","موظف في مستشفى","موظف في عيادة",
] as const;
export function MarketFriendReferral({cardId}:{cardId:number|null;cardName?:string|null}){
  const {user}=useSession();
  const [open,setOpen]=useState(false);
  const [phone,setPhone]=useState("");
  const [note,setNote]=useState("");
  const [category,setCategory]=useState<(typeof categories)[number]>("مستخدم");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const request=useRef<{json:string;key:string}|null>(null);
  if(!user)return null;
  async function submit(event:FormEvent){
    event.preventDefault();
    if(busy)return;
    const payload={phone:phone.trim(),note:note.trim(),category,cardId};
    const json=JSON.stringify(payload);
    const key=request.current?.json===json?request.current.key:crypto.randomUUID();
    request.current={json,key};
    setBusy(true);setError("");setSuccess("");
    try{
      await api("/medicine-market/friend-referrals",{
        method:"POST",body:{...payload,idempotencyKey:key},
      });
      request.current=null;
      setPhone("");setNote("");setCategory("مستخدم");
      setSuccess("تم الحفظ بنجاح");
    }catch(cause){setError(cause instanceof Error?cause.message:"تعذر حفظ البيانات");}
    finally{setBusy(false);}
  }
  return <>
    <Button variant="secondary" onClick={()=>{setError("");setSuccess("");setOpen(true);}}>تعريف التطبيق لصديق</Button>
    <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}}
      title="تعريف التطبيق لصديق" className="market-friend-dialog">
      <form onSubmit={event=>void submit(event)} className="form-stack" dir="rtl">
        {error&&<Notice tone="error">{error}</Notice>}
        {success&&<Notice tone="success">{success}</Notice>}
        <label className="field">رقم الهاتف المستهدف
          <input required type="tel" inputMode="tel" dir="ltr"
            value={phone} onChange={e=>setPhone(e.target.value)}
            maxLength={24} placeholder="7XXXXXXXX أو +9677XXXXXXXX"
            disabled={busy}/>
        </label>
        <label className="field">الفئة
          <select value={category} onChange={e=>setCategory(e.target.value as typeof category)}
            disabled={busy}>{categories.map(value=><option key={value} value={value}>{value}</option>)}</select>
        </label>
        <label className="field">بيان
          <textarea rows={2} maxLength={1000} value={note}
            onChange={e=>setNote(e.target.value)} disabled={busy}
            placeholder="بيان اختياري"/>
        </label>
        <div className="form-actions">
          <Button type="submit" disabled={busy||!phone.trim()}>
            {busy?"جارٍ الحفظ…":"حفظ"}
          </Button>
        </div>
      </form>
    </Dialog>
  </>;
}

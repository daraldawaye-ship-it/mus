import { useRef, useState, type FormEvent } from "react";
import { ContactRound } from "lucide-react";
import { api, useSession } from "./api";
import { Button, Dialog, Notice } from "./ui";

const categories = [
  "مستخدم","دكتور جامعه","طبيب","طالب صيدليه","صيدلي",
  "صيدلي موظف في صيدليه","مالك صيدليه","مندوب شركه","متحصل شركه",
  "سوبر فايزر شركة","مالك شركة - وكيل","مالك محل جمله",
  "موظف في محل جمله","موزع ادويه - شخصي","موظف في مستشفى","موظف في عيادة",
] as const;
type DeviceContact = { name?: string[]; tel?: string[] };
type ContactsNavigator = Navigator & {
  contacts?: { select: (properties: Array<"name" | "tel">, options: {multiple:boolean}) => Promise<DeviceContact[]> };
};
const normalizeContactPhone=(input:string)=>input
  .replace(/[٠-٩]/g, digit=>String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
  .replace(/[۰-۹]/g, digit=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
  .replace(/[\u200e\u200f\u202a-\u202e\s()\-]/g,"")
  .replace(/^00/,"+");
export function MarketFriendReferral({cardId}:{cardId:number|null;cardName?:string|null}){
  const {user}=useSession();
  const [open,setOpen]=useState(false);
  const [phone,setPhone]=useState("");
  const [note,setNote]=useState("");
  const [category,setCategory]=useState<(typeof categories)[number]>("مستخدم");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [selectingContact,setSelectingContact]=useState(false);
  const [contactPhones,setContactPhones]=useState<string[]>([]);
  const [contactName,setContactName]=useState("");
  const request=useRef<{json:string;key:string}|null>(null);
  function chooseContactPhone(number:string,name:string){
    setPhone(normalizeContactPhone(number));
    if(name.trim())setNote(name.trim().slice(0,1000));
    setContactPhones([]);
    setError("");setSuccess("");
  }
  async function selectFromDevice(){
    const contacts=(navigator as ContactsNavigator).contacts;
    if(!contacts?.select){
      setError("اختيار جهات الاتصال غير مدعوم في هذا المتصفح. يمكنك إدخال الاسم والرقم يدويًا.");
      return;
    }
    if(selectingContact||busy)return;
    setSelectingContact(true);setError("");setSuccess("");
    try{
      const selected=await contacts.select(["name","tel"],{multiple:false});
      const first=selected[0];
      if(!first)return;
      const name=first.name?.[0]?.trim()??"";
      const phones=[...new Set((first.tel??[]).map(normalizeContactPhone).filter(value=>/^\+?[0-9]{6,20}$/.test(value)))];
      if(!phones.length){
        setError("جهة الاتصال المحددة لا تحتوي رقم هاتف صالحًا.");
        return;
      }
      if(phones.length===1)chooseContactPhone(phones[0],name);
      else {setContactName(name);setContactPhones(phones);}
    }catch(cause){
      if(cause instanceof DOMException && ["AbortError","NotAllowedError"].includes(cause.name))return;
      setError("تعذر اختيار جهة الاتصال. تحقق من دعم المتصفح وإذن جهات الاتصال.");
    }finally{setSelectingContact(false);}
  }
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
        <Button type="button" variant="secondary" disabled={busy||selectingContact}
          onClick={()=>void selectFromDevice()}>
          <ContactRound size={17}/> {selectingContact?"جارٍ اختيار جهة الاتصال…":"اختيار اسم ورقم من جهات الاتصال"}
        </Button>
        {!!contactPhones.length&&<label className="field">اختر رقم جهة الاتصال
          <select value="" onChange={e=>{if(e.target.value)chooseContactPhone(e.target.value,contactName);}}>
            <option value="">حدد رقمًا</option>
            {contactPhones.map(number=><option key={number} value={number} dir="ltr">{number}</option>)}
          </select>
        </label>}
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

import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, useSession } from "./api";
import { Button, Dialog, Notice } from "./ui";

const categories = [
  "مستخدم","دكتور جامعه","طبيب","طالب صيدليه","صيدلي",
  "صيدلي موظف في صيدليه","مالك صيدليه","مندوب شركه","متحصل شركه",
  "سوبر فايزر شركة","مالك شركة - وكيل","مالك محل جمله",
  "موظف في محل جمله","موزع ادويه - شخصي","موظف في مستشفى","موظف في عيادة",
] as const;
type Referral={
  id:number;phone:string;note:string;category:string;
  referredBy:string;createdAt:string;cardId:number|null;cardName:string|null;
};
type ReferralPage={items:Referral[];total:number;page:number;pageSize:number};
const dateTime = (value:string)=>new Intl.DateTimeFormat("ar-YE",{
  timeZone:"Asia/Aden",year:"numeric",month:"2-digit",day:"2-digit",
  hour:"2-digit",minute:"2-digit",
}).format(new Date(value));
export function MarketFriendReferral({cardId,cardName}:{
  cardId:number|null;cardName?:string|null;
}){
  const {user}=useSession(),cache=useQueryClient();
  const [open,setOpen]=useState(false);
  const [phone,setPhone]=useState("");
  const [note,setNote]=useState("");
  const [category,setCategory]=useState<(typeof categories)[number]>("مستخدم");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [page,setPage]=useState(1);
  const [all,setAll]=useState(false);
  const request=useRef<{json:string;key:string}|null>(null);
  const list=useQuery({
    queryKey:["medicine-market",user?.id,"friend-referrals",page,all],
    queryFn:({signal})=>api<ReferralPage>(
      "/medicine-market/friend-referrals?"+new URLSearchParams({
        page:String(page),...(all?{all:"true"}:{}),
      }),{signal}),
    enabled:!!user&&open,
  });
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
      setPhone("");setNote("");setCategory("مستخدم");setPage(1);
      setSuccess("تم تسجيل بيانات الصديق. لن يُرسل أي رابط أو رسالة تلقائيًا.");
      await cache.invalidateQueries({queryKey:["medicine-market",user?.id,"friend-referrals"]});
    }catch(cause){setError(cause instanceof Error?cause.message:"تعذر حفظ البيانات");}
    finally{setBusy(false);}
  }
  return <>
    <Button variant="secondary" onClick={()=>setOpen(true)}>تعريف التطبيق لصديق</Button>
    <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}}
      title="تعريف التطبيق لصديق" className="market-friend-dialog">
      <div className="form-stack" dir="rtl">
        <p className="muted">هذا سجل للمتابعة فقط. لن يرسل الموقع رابط التطبيق عبر واتساب تلقائيًا.</p>
        {cardId && <small>الكرت المفتوح عند الإضافة: <strong>{cardName||"#"+cardId}</strong></small>}
        {error&&<Notice tone="error">{error}</Notice>}
        {success&&<Notice tone="success">{success}</Notice>}
        <form onSubmit={event=>void submit(event)} className="form-stack">
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
              placeholder="معلومة اختيارية عن الشخص أو سبب التعريف"/>
          </label>
          <div className="form-actions">
            <Button type="submit" disabled={busy||!phone.trim()}>
              {busy?"جارٍ الحفظ…":"إضافة إلى الجدول"}
            </Button>
          </div>
        </form>
        <div className="archive-pagination">
          <strong>جدول تعريف التطبيق للأصدقاء</strong>
          {user.owner&&<label className="check-label">
            <input type="checkbox" checked={all}
              onChange={e=>{setAll(e.target.checked);setPage(1);}}/>
            عرض جميع المستخدمين
          </label>}
        </div>
        {list.isPending&&<p>جارٍ تحميل السجلات…</p>}
        {list.error&&<Notice tone="error">{list.error instanceof Error?list.error.message:"تعذر جلب السجلات"}</Notice>}
        <div style={{overflowX:"auto"}}>
          <table className="archive-table" style={{minWidth:850}}>
            <thead><tr>
              <th>بواسطة</th><th>رقم الهاتف المستهدف</th><th>بيان</th>
              <th>الفئة</th><th>الوقت والتاريخ</th><th>الكرت المفتوح عند الإضافة</th>
            </tr></thead>
            <tbody>{(list.data?.items??[]).map(row=><tr key={row.id}>
              <td>{row.referredBy}</td><td dir="ltr">{row.phone}</td>
              <td>{row.note||"—"}</td><td>{row.category}</td>
              <td style={{whiteSpace:"nowrap"}}>{dateTime(row.createdAt)}</td>
              <td>{row.cardId
                ?<Link to={"/medicine-market?card="+row.cardId} onClick={()=>setOpen(false)}>
                  {row.cardName||"#"+row.cardId}
                </Link>:"—"}</td>
            </tr>)}</tbody>
          </table>
          {!list.isPending&&!list.data?.items.length&&<p className="muted">لا توجد سجلات حتى الآن.</p>}
        </div>
        <div className="archive-pagination">
          <span>الإجمالي: {list.data?.total??0}</span>
          <Button variant="secondary" size="compact" disabled={page<=1}
            onClick={()=>setPage(v=>v-1)}>السابق</Button>
          <span>صفحة {page}</span>
          <Button variant="secondary" size="compact"
            disabled={page*(list.data?.pageSize??30)>=(list.data?.total??0)}
            onClick={()=>setPage(v=>v+1)}>التالي</Button>
        </div>
      </div>
    </Dialog>
  </>;
}

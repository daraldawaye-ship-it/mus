import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";
import { formatMoney } from "./format-money";
import { Button, Dialog, Field, Notice } from "./ui";

type Pledge = {
 accountId:number; code:string; name:string; limit:string; balance:string; customerName:string;
 phone:string; collateral:string; durationDays:number; receivedBy:string; createdAt:string;
};
export function PledgeDialogs({
 companyId,mode,onClose,onCreated,onSelect,
}: {
 companyId:number;mode:"add"|"list"|null;onClose:()=>void;
 onCreated:(account:Account,points:number)=>void;
 onSelect:(accountId:number)=>void;
}) {
 const cache=useQueryClient();
 const [customerName,setCustomerName]=useState("");
 const [phone,setPhone]=useState("");
 const [collateral,setCollateral]=useState("");
 const [durationDays,setDurationDays]=useState("2");
 const [limit,setLimit]=useState("");
 const [q,setQ]=useState("");
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const requestKey=useRef(crypto.randomUUID());
 const pledges=useQuery({
  queryKey:["pledges",companyId,q],
  enabled:mode==="list",
  queryFn:({signal})=>api<{items:Pledge[]}>(`/companies/${companyId}/pledges?q=${encodeURIComponent(q)}`,{signal}),
 });
 async function create(event:FormEvent) {
  event.preventDefault();
  if(saving)return;
  setSaving(true);setError("");
  try {
   const result=await api<{account:Account;awardedPoints:number}>(
    `/companies/${companyId}/pledges`,
    {method:"POST",body:{
      idempotencyKey:requestKey.current,customerName,phone,collateral,
      durationDays:Number(durationDays),limit,
    }}
   );
   requestKey.current=crypto.randomUUID();
   setCustomerName("");setPhone("");setCollateral("");setDurationDays("2");setLimit("");
   await cache.invalidateQueries({queryKey:["pledges",companyId]});
   onCreated(result.account,result.awardedPoints);
   onClose();
  }catch(e){setError(errorMessage(e));}
  finally{setSaving(false);}
 }
 return <>
 <Dialog open={mode==="add"} title="إضافة رهن" onClose={onClose}>
  <form className="form-stack" onSubmit={event=>void create(event)}>
   {error&&<Notice tone="error">{error}</Notice>}
   <Field label="الاسم" value={customerName} onChange={e=>setCustomerName(e.target.value)} required maxLength={120} />
   <div className="form-grid">
    <Field label="رقم الهاتف" inputMode="tel" value={phone} onChange={e=>setPhone(e.target.value)} required maxLength={20} />
    <Field label="الرهن" value={collateral} onChange={e=>setCollateral(e.target.value)} required maxLength={160} />
    <Field label="المدة بالأيام" type="number" min={1} step={1} value={durationDays} onChange={e=>setDurationDays(e.target.value)} required />
    <Field label="السقف" money inputMode="decimal" value={limit} onChange={e=>setLimit(e.target.value)} required />
   </div>
   <p className="muted">السقف يحدده مستلم الرهن ويتحمل مسؤولية تقييمه. إنشاء الرهن لا ينشئ حركة مالية.</p>
   <div className="form-actions">
    <Button type="submit" disabled={saving}>{saving?"جارٍ الإضافة…":"حفظ الرهن"}</Button>
    <Button variant="secondary" onClick={onClose} disabled={saving}>إلغاء</Button>
   </div>
  </form>
 </Dialog>
 <Dialog open={mode==="list"} title="عرض الرهونات" onClose={onClose}>
  <div className="form-stack">
   <Field label="البحث بالاسم أو الهاتف أو وصف الرهن أو رقم الحساب" value={q} onChange={e=>setQ(e.target.value)} />
   {pledges.error && <Notice tone="error">{errorMessage(pledges.error)}</Notice>}
   {pledges.isFetching && <p>جارٍ تحميل الرهونات…</p>}
   <div className="table-scroll pledge-list-table-scroll">
    <table>
     <thead><tr><th>الرصيد</th><th>الحساب</th><th>الرهن</th><th>الهاتف</th><th>السقف</th><th>الإجراءات</th></tr></thead>
     <tbody>
      {(pledges.data?.items??[]).map(item=><tr key={item.accountId}>
       <td><bdi className={item.balance.startsWith("-") ? "receipt-negative-amount" : undefined}>{formatMoney(item.balance.startsWith("-") ? item.balance.slice(1) : item.balance)}{Number(item.balance) < 0 ? " دائن" : Number(item.balance) > 0 ? " مدين" : ""}</bdi></td>
       <td><bdi>{item.code}</bdi> — {item.customerName}</td>
       <td>{item.collateral} ({item.durationDays} يوم)</td>
       <td><bdi>{item.phone}</bdi></td>
       <td><bdi>{formatMoney(item.limit)}</bdi></td>
       <td>
        <Link className="button button-secondary" to={`/companies/${companyId}/account-ledger?accountId=${item.accountId}&pledge=1`} target="_blank" rel="noopener noreferrer">كشف الحساب / طباعة</Link>{" "}
        <Button variant="secondary" onClick={()=>{onSelect(item.accountId);onClose();}}>اختيار</Button>
       </td>
      </tr>)}
     </tbody>
    </table>
   </div>
   {!pledges.isFetching && pledges.data?.items.length===0 && <p className="muted">لا توجد رهونات مطابقة.</p>}
  </div>
 </Dialog>
 </>;
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { financialDocumentSchema, normalizeDigits, type Account, type FinancialDocument } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";
import { formatMoney } from "./format-money";
import { Button, Dialog, Field, Notice } from "./ui";

type Pledge = {
 accountId:number; code:string; name:string; limit:string; balance:string; customerName:string;
 phone:string; collateral:string; durationDays:number; receivedBy:string; createdAt:string;
};
export function PledgeDialogs({
 companyId,mode,cashbox,yerCurrencyId,onClose,onCreated,onSelect,
}: {
 companyId:number;mode:"add"|"list"|"pay"|"receive"|null;cashbox:Account|null;yerCurrencyId:number|null;onClose:()=>void;
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
 const [selectedPledge,setSelectedPledge]=useState<Pledge|null>(null);
 const [transferAmount,setTransferAmount]=useState("");
 const [transferNotes,setTransferNotes]=useState("");
 const [transferBusy,setTransferBusy]=useState(false);
 const [transferError,setTransferError]=useState("");
 const [pendingDraft,setPendingDraft]=useState<FinancialDocument|null>(null);
 const [lastPosted,setLastPosted]=useState<{id:number;number:string;mode:"pay"|"receive"}|null>(null);
 const transferKey=useRef(crypto.randomUUID());
 useEffect(()=>{
  if(mode!=="pay" && mode!=="receive") return;
  setSelectedPledge(null);setTransferAmount("");setTransferNotes("");setTransferError("");
  setPendingDraft(null);transferKey.current=crypto.randomUUID();
 },[mode]);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const requestKey=useRef(crypto.randomUUID());
 const pledges=useQuery({
  queryKey:["pledges",companyId,q],
  enabled:mode==="list"||mode==="pay"||mode==="receive",
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

 async function transfer(event:FormEvent) {
  event.preventDefault();
  if(transferBusy || (mode!=="pay" && mode!=="receive"))return;
  setTransferError("");
  if(!cashbox || !yerCurrencyId) {setTransferError("لا يوجد صندوق مبيعات محدد أو عملة ريال يمنية فعالة.");return;}
  if(!selectedPledge){setTransferError("اختر الرهن الذي ستسجل عليه الحركة.");return;}
  if(selectedPledge.accountId===cashbox.id){setTransferError("لا يمكن التحويل إلى الصندوق نفسه.");return;}
  const amount=normalizeDigits(transferAmount.trim()).replace(/٫/g,".");
  if(!/^\d{1,22}(?:\.\d{1,6})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount)<=0){
   setTransferError("أدخل مبلغًا موجبًا صالحًا.");return;
  }
  const kind=mode==="pay"?"payment":"receipt";
  const description=(mode==="pay"?"صرف مبلغ لرهن: ":"استلام مبلغ من رهن: ")+selectedPledge.customerName+
   (transferNotes.trim()?" — "+transferNotes.trim():"");
  const lines=[
   {accountId:cashbox.id,debit:kind==="receipt"?amount:"0",credit:kind==="payment"?amount:"0",description:description.slice(0,500)},
   {accountId:selectedPledge.accountId,debit:kind==="payment"?amount:"0",credit:kind==="receipt"?amount:"0",description:description.slice(0,500)},
  ];
  const parsed=financialDocumentSchema.safeParse({
   kind,documentDate:new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Aden"}),
   currencyId:yerCurrencyId,branchId:null,cashAccountId:cashbox.id,
   supplierReceiptNumber:"",description:description.slice(0,1000),lines,
   idempotencyKey:transferKey.current,
  });
  if(!parsed.success){setTransferError(parsed.error.issues[0]?.message??"راجع بيانات السند.");return;}
  setTransferBusy(true);
  try{
   let draft=pendingDraft;
   if(!draft){
    const created=await api<{document:FinancialDocument}>(
     "/companies/"+companyId+"/financial-documents",{method:"POST",body:parsed.data}
    );
    draft=created.document;
    setPendingDraft(draft);
   }else{
    const refreshed=await api<{document:FinancialDocument}>(
     "/companies/"+companyId+"/financial-documents/"+draft.id
    );
    draft=refreshed.document;
   }
   const posted=draft.status==="posted"?draft:(await api<{document:FinancialDocument}>(
    "/companies/"+companyId+"/financial-documents/"+draft.id+"/post",
    {method:"POST",body:{revision:draft.revision}}
   )).document;
   if(posted.status!=="posted")throw new Error("لم يؤكد الخادم ترحيل السند.");
   setLastPosted({id:posted.id,number:posted.number,mode});
   setPendingDraft(null);transferKey.current=crypto.randomUUID();
   setSelectedPledge(null);setTransferAmount("");setTransferNotes("");
   void cache.invalidateQueries({queryKey:["pledges",companyId]});
   void cache.invalidateQueries({predicate:({queryKey})=>
    queryKey.includes(companyId) && (queryKey[0]==="list" || queryKey[0]==="finance" ||
    queryKey[0]==="account-ledger" || queryKey[0]==="account-balances")
   });
   onClose();
  }catch(e){
   setTransferError(errorMessage(e)+(pendingDraft?" تم إنشاء سند مسودة، ويمكن إعادة محاولة ترحيله دون إنشاء سند جديد.":""));
  }finally{setTransferBusy(false);}
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

 <Dialog open={mode==="pay"||mode==="receive"}
  title={mode==="pay"?"صرف مبلغ لرهن":"استلام مبلغ من رهن"}
  onClose={()=>{if(!transferBusy)onClose();}}>
  <form className="form-stack" onSubmit={event=>void transfer(event)}>
   <p className="muted">تُسجل الحركة في سند مالي مستقل بين صندوق الموظف وحساب الرهن، دون تغيير أصناف الفاتورة أو إجماليها.</p>
   <p>الصندوق: <strong>{cashbox?cashbox.name:"لم يتم تعيين صندوق"}</strong> — العملة: ريال يمني</p>
   <Field label="ابحث عن الرهن بالاسم أو الهاتف أو الوصف" value={q}
    disabled={transferBusy||!!pendingDraft} onChange={event=>setQ(event.target.value)} />
   {pledges.error && <Notice tone="error">{errorMessage(pledges.error)}</Notice>}
   {pledges.isFetching && <p className="muted">جارٍ تحميل الرهونات…</p>}
   <div className="table-scroll pledge-list-table-scroll">
    <table>
     <thead><tr><th>اختيار</th><th>الرهن</th><th>الحساب</th><th>الرصيد</th></tr></thead>
     <tbody>{(pledges.data?.items??[]).map(item=>
      <tr key={item.accountId}>
       <td><Button variant="secondary" type="button" disabled={transferBusy||!!pendingDraft}
        onClick={()=>setSelectedPledge(item)}>
        {selectedPledge?.accountId===item.accountId?"تم الاختيار":"اختيار"}
       </Button></td>
       <td>{item.customerName} — {item.collateral}</td>
       <td><bdi>{item.code}</bdi></td>
       <td><bdi>{formatMoney(item.balance)}</bdi></td>
      </tr>)}</tbody>
    </table>
   </div>
   {!pledges.isFetching && pledges.data?.items.length===0 && <p className="muted">لا توجد رهونات مطابقة.</p>}
   {selectedPledge&&<p>الرهن المختار: <strong>{selectedPledge.customerName} — {selectedPledge.code}</strong></p>}
   <Field label="المبلغ" money inputMode="decimal" required value={transferAmount}
    disabled={transferBusy||!!pendingDraft} onChange={event=>setTransferAmount(event.target.value)} />
   <Field label="البيان — اختياري" maxLength={400} value={transferNotes}
    disabled={transferBusy||!!pendingDraft} onChange={event=>setTransferNotes(event.target.value)} />
   {transferError&&<Notice tone="error">{transferError}</Notice>}
   {pendingDraft&&<Notice tone="warning">تم إنشاء سند مسودة رقم {pendingDraft.number}.{" "}
    <Link to={"/companies/"+companyId+"/financial-documents/"+pendingDraft.id} target="_blank" rel="noopener noreferrer">فتح السند</Link>
   </Notice>}
   <div className="form-actions">
    <Button type="submit" disabled={transferBusy||!cashbox||!yerCurrencyId||!selectedPledge}>
     {transferBusy?"جارٍ الحفظ والترحيل…":pendingDraft?"إعادة محاولة الترحيل":"حفظ وترحيل السند"}
    </Button>
    <Button type="button" variant="secondary" disabled={transferBusy} onClick={onClose}>إغلاق</Button>
   </div>
  </form>
 </Dialog>
 {lastPosted&&<Notice tone="success">
  {lastPosted.mode==="pay"?"تم صرف المبلغ للرهن.":"تم استلام المبلغ من الرهن."}{" "}
  <Link to={"/companies/"+companyId+"/financial-documents/"+lastPosted.id}>فتح السند رقم {lastPosted.number}</Link>
 </Notice>}
 </>;
}

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/index.ts";
import { ApiFailure, api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";

type Status="pending"|"received"|"all";
type Movement={
  id:number;kind:"pouch"|"close"|"electronic";employeeName:string;amount:string;
  notes:string;createdAt:string;sourceDocumentId:number;pouchName?:string;walletName?:string;
  receiptId:number|null;receiptMode:"exact"|"difference"|null;
  receivedAmount:string|null;differenceAmount:string|null;
  receiverName:string|null;receiptDocumentId:number|null;voucherDocumentId:number|null;
  receiptNotes:string|null;receivedAt:string|null;
};
type Response={items:Movement[];total:number;page:number;pageSize:number};
type Draft={movement:Movement;amount:string;notes:string;key:string};
type VoucherDraft={
  movement:Movement;key:string;notes:string;receiptNumber:string;
  accountId:string;search:string;attempt:"voucher"|"transfer"|null;
};
type Counterparty={id:number;code:string;name:string};

/** Right-to-left order shared by cash pouches and electronic wallets. */
export const receiptTableColumns=(sourceName:string)=>[
  "الموظف","المبلغ","ملاحظات","استلام","جزء",
  "التاريخ",sourceName,"نوع الحركة","الحالة",
] as const;

/** The register is whole-rial display only; preserve the original amount in API/DB. */
function ReceiptAmount({value}:{value:string|null|undefined}) {
  return <bdi className={value?.startsWith("-") ? "receipt-negative-amount" : undefined}>
    {formatWholeMoney(value)}
  </bdi>;
}

const dateTime=(value:string)=>new Intl.DateTimeFormat("en-GB",{
  day:"2-digit",month:"2-digit",year:"2-digit",
  hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Aden",
}).format(new Date(value)).replace(",","");

export function PouchReceiptsPage({context,source="pouch"}:{
  context:CompanyContext;source?:"pouch"|"electronic";
}) {
  const companyId=context.company.id;
  const electronic=source==="electronic";
  const endpoint=electronic?"electronic-receipts":"pouch-receipts";
  const sourceName=electronic?"المحفظة الإلكترونية":"الحافظة";
  const heading=electronic?"استلام المحفظة الإلكترونية":"استلام الترحيلات";
  // Explain the difference without relying solely on the table's type column.
  const movementLabel=(kind:Movement["kind"])=>kind==="close"
    ?"إغلاق صندوق":kind==="pouch"?"ترحيل عادي":"ترحيل إلكتروني";

  const {user}=useSession();
  const client=useQueryClient();
  const [status,setStatus]=useState<Status>("pending");
  const [page,setPage]=useState(1);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [voucherDraft,setVoucherDraft]=useState<VoucherDraft|null>(null);
  const [inspected,setInspected]=useState<Movement|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState<{documentId:number;voucherDocumentId:number|null;difference:string}|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const [exactKeys,setExactKeys]=useState<Record<number,string>>({});
  const canPost=context.general||context.permissions.includes("finance.post");
  const queryKey=[endpoint,user?.id,companyId,status,page] as const;
  const counterpart=useQuery<{items:Counterparty[]}>({
    queryKey:["receipt-counterpart-accounts",user?.id,companyId,voucherDraft?.search??""],
    queryFn:({signal})=>api<{items:Counterparty[]}>(
      `/companies/${companyId}/receipt-counterpart-accounts?q=${encodeURIComponent(voucherDraft?.search??"")}`,{signal}),
    enabled:!!user && !!voucherDraft,
  });
  const list=useQuery<Response>({
    queryKey,
    queryFn:({signal})=>api<Response>(
      `/companies/${companyId}/${endpoint}?${new URLSearchParams({
        status,page:String(page),pageSize:"50",
      })}`,{signal},
    ),
    enabled:!!user,
  });
  async function postReceipt(
    item:Movement,mode:"exact"|"difference",amount:string,notes:string,key:string,
    voucher?:{counterpartyAccountId:number;notes:string;receiptNumber:string},
  ) {
    if(pending || !canPost)return;
    setError("");setNotice(null);setPending(true);
    try {
      const body=mode==="exact"
        ? {sourceOperationId:item.id,mode,notes,idempotencyKey:key,...(voucher?{voucher}:{})}
        : {sourceOperationId:item.id,mode,receivedAmount:normalizeDigits(amount).replace(/,/g,""),
           notes,idempotencyKey:key};
      const result=await api<{
        receipt:{id:number;documentId:number;voucherDocumentId:number|null;expected:string;
          received:string;difference:string};
      }>(`/companies/${companyId}/${endpoint}`,{
        method:"POST",body,
      });
      setNotice({documentId:result.receipt.documentId,
        voucherDocumentId:result.receipt.voucherDocumentId,
        difference:result.receipt.difference});
      setDraft(null);setVoucherDraft(null);setUncertain(false);
      setExactKeys(prev=>{const next={...prev};delete next[item.id];return next;});
      await client.invalidateQueries({predicate:query=>
        query.queryKey.includes(companyId) &&
        (query.queryKey[0]==="pouch-receipts" ||
          query.queryKey[0]==="electronic-receipts" ||
          query.queryKey[0]==="finance" ||
          query.queryKey[0]==="account-balances" ||
          query.queryKey[0]==="account-ledger")});
    }catch(e){
      const networkUncertain=!(e instanceof ApiFailure)||e.status>=500;
      setUncertain(networkUncertain);
      if(!networkUncertain) setVoucherDraft(prev=>prev?{...prev,attempt:null}:prev);
      setError(networkUncertain
        ? "قد تكون العملية قد تمت. أعد تأكيد الطلب نفسه دون تغيير البيانات حتى لا يتكرر الاستلام. "+errorMessage(e)
        : errorMessage(e));
    }finally{setPending(false);}
  }
  function exact(item:Movement) {
    // Electronic wallet receipts post the accounting transfer immediately.
    // Only cash pouches offer the optional companion voucher dialogue.
    if(!electronic && item.kind!=="close"){
      setUncertain(false);setError("");
      setVoucherDraft({movement:item,key:crypto.randomUUID(),notes:item.notes||"",
        receiptNumber:"",accountId:"",search:"",attempt:null});
      return;
    }
    const key=exactKeys[item.id]??crypto.randomUUID();
    setExactKeys(prev=>({...prev,[item.id]:key}));
    void postReceipt(item,"exact","", "",key);
  }
  function confirmTransfer(withVoucher:boolean) {
    if(!voucherDraft || pending)return;
    const selection=withVoucher?"voucher":"transfer";
    if(voucherDraft.attempt && voucherDraft.attempt!==selection)return;
    if(withVoucher && (!voucherDraft.accountId || !Number.isSafeInteger(Number(voucherDraft.accountId)))) {
      setError("اختر الحساب المقابل للسند قبل الحفظ");
      return;
    }
    setVoucherDraft(prev=>prev?{...prev,attempt:selection}:prev);
    void postReceipt(voucherDraft.movement,"exact","",voucherDraft.notes,voucherDraft.key,
      withVoucher?{
        counterpartyAccountId:Number(voucherDraft.accountId),
        notes:voucherDraft.notes,
        receiptNumber:voucherDraft.receiptNumber,
      }:undefined);
  }
  function partial(item:Movement) {
    setUncertain(false);setError("");
    setDraft({movement:item,amount:"",notes:"",key:crypto.randomUUID()});
  }
  function submit(event:FormEvent) {
    event.preventDefault();
    if(!draft)return;
    const amount=normalizeDigits(draft.amount).replace(/,/g,"");
    if(!/^-?(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,2})?$/.test(amount)) {
      setError("أدخل مبلغًا صالحًا، ويمكن أن يكون صفرًا.");
      return;
    }
    const original=Number(draft.movement.amount),current=Number(amount);
    if(current!==0 && Math.sign(current)!==Math.sign(original)){
      setError("أدخل المبلغ بنفس إشارة الحركة الأصلية، أو صفرًا.");
      return;
    }
    if(current===original) {
      setError("المبلغ مطابق؛ استخدم زر استلام مطابق بدلًا من غير مطابق.");
      return;
    }
    void postReceipt(draft.movement,"difference",amount,draft.notes,draft.key);
  }
  return (
    <div className="pouch-receipts-page">
      <PageHeader title={heading}
        description={electronic
          ? "تحويلات المحفظة الإلكترونية إلى صندوقك؛ ويُرحّل أي فرق إلى العجز والزيادة."
          : "حركات الحوافظ وإغلاق الصناديق للاستلام في صندوقك؛ ويُرحّل الفرق إلى العجز والزيادة."}
        actions={<Button variant="secondary" onClick={()=>void list.refetch()}
          disabled={list.isFetching||pending}>تحديث</Button>}/>
      {!electronic && <p className="receipt-kind-help">
        <strong>إغلاق صندوق:</strong> جرد النقد الفعلي عند إغلاق الوردية وترحيله للحافظة مع تسجيل أي فرق.
        {" — "}
        <strong>ترحيل عادي:</strong> تحويل مبلغ من صندوق الموظف إلى الحافظة دون إغلاق الصندوق.
      </p>}
      {notice&&<Notice tone="success">
        تم الاستلام وتسجيل قيد التحويل #{notice.documentId}.
        {notice.voucherDocumentId!==null && <>
          {" "}وإنشاء <Link to={`/companies/${companyId}/financial-documents/${notice.voucherDocumentId}`}>السند المرافق</Link>.
        </>}
        {Number(notice.difference)===0
          ? " المبلغ مطابق."
          : <> الفرق: <ReceiptAmount value={notice.difference}/> ريال في حساب العجز والزيادة.</>}
      </Notice>}
      {error&&!draft&&!voucherDraft&&<Notice tone="error">{error}</Notice>}
      <div className="form-actions" role="group" aria-label={`حالة استلام ${sourceName}`}>
        {(["pending","received","all"] as const).map(value=>
          <Button key={value} variant={status===value?"primary":"secondary"}
            onClick={()=>{setStatus(value);setPage(1);setError("");}}>
            {value==="pending"?"بانتظار الاستلام":value==="received"?"تم الاستلام":"كل الحركات"}
          </Button>
        )}
      </div>
      <Card title={electronic?"حركات المحفظة الإلكترونية":"حركات الحوافظ"}
        description={`عدد الحركات: ${list.data?.total??"…"} — يشمل الحركات الموجبة والسالبة.`}>
        {list.isLoading&&<p>جارٍ تحميل الحركات…</p>}
        {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
        {list.data?.items.length===0&&<p className="muted">لا توجد حركات مطابقة لهذه الحالة.</p>}
        {!!list.data?.items.length&&(
          <div className="pouch-receipts-mobile-list" role="list"
            aria-label={`حركات ${sourceName} للهاتف`}>
            {list.data.items.map(item=>(
              <article key={item.id} className="receipt-mobile-entry" role="listitem">
                <div className="receipt-mobile-primary">
                  <strong className="receipt-mobile-employee" title={item.employeeName+
                    " — "+(electronic?item.walletName??"":item.pouchName??"")}>
                    {item.employeeName}
                  </strong>
                  {!electronic&&<span className={`receipt-kind-marker ${item.kind==="close"?"receipt-kind-close":"receipt-kind-transfer"}`}
                    title={item.kind==="close"?"جرد وإغلاق الصندوق في نهاية الوردية":"ترحيل عادي دون إغلاق الصندوق"}>
                    {movementLabel(item.kind)}
                  </span>}
                  <strong className="receipt-mobile-amount">
                    <ReceiptAmount value={item.amount}/>
                  </strong>
                </div>
                <div className="receipt-mobile-secondary">
                  <div className="receipt-mobile-description">
                    <bdi dir="ltr" className="receipt-mobile-date">{dateTime(item.createdAt)}</bdi>
                    <button type="button" className="receipt-mobile-note"
                      title={item.notes||`تفاصيل الحركة ${item.id}`}
                      onClick={()=>setInspected(item)}>
                      {item.notes||"التفاصيل"}
                    </button>
                  </div>
                  <div className="receipt-mobile-buttons">
                    {item.receiptId!==null
                      ? <Link className="button button-secondary button-compact"
                          to={`/companies/${companyId}/financial-documents/${item.receiptDocumentId}`}>القيد</Link>
                      : canPost
                        ? <>
                            <Button size="compact" disabled={pending}
                              onClick={()=>exact(item)}>مطابق</Button>
                            {item.kind==="close"&&
                              <Button size="compact" variant="secondary"
                                disabled={pending} onClick={()=>partial(item)}>
                                جزء
                              </Button>}
                          </>
                        : <span className="receipt-status-pending">بانتظار</span>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {!!list.data?.items.length&&(
          <div className="pouch-receipts-table-wrap" role="region"
            aria-label={`جدول حركات ${sourceName}`} tabIndex={0}>
            <table className="pouch-receipts-table">
              <colgroup>
                <col className="receipt-col-employee" />
                <col className="receipt-col-amount" />
                <col className="receipt-col-notes" />
                <col className="receipt-col-exact" />
                <col className="receipt-col-partial" />
                <col className="receipt-col-date" />
                <col className="receipt-col-source" />
                <col className="receipt-col-kind" />
                <col className="receipt-col-status" />
              </colgroup>
              <thead>
                <tr>{receiptTableColumns(sourceName).map(label=>
                  <th key={label} scope="col">{label}</th>
                )}</tr>
              </thead>
              <tbody>{list.data.items.map(item=>{
                const statusDetails = item.receiptId === null
                  ? "بانتظار الاستلام"
                  : `تم الاستلام بواسطة ${item.receiverName??"—"}؛ فعلي: ${formatWholeMoney(item.receivedAmount)}؛ الفرق: ${formatWholeMoney(item.differenceAmount)}`;
                const movementKind=movementLabel(item.kind);
                return (
                  <tr key={item.id}>
                    <td title={item.employeeName}>
                      <span className="receipt-cell-ellipsis">{item.employeeName}</span>
                    </td>
                    <td className="receipt-cell-amount">
                      <ReceiptAmount value={item.amount}/>
                    </td>
                    <td>
                      {item.notes
                        ? <button type="button" className="receipt-cell-trigger"
                            title={item.notes} onClick={()=>setInspected(item)}
                            aria-label={`عرض ملاحظات حركة ${item.id}`}>
                            {item.notes}
                          </button>
                        : "—"}
                    </td>
                    <td>
                      {item.receiptId !== null
                        ? <Link className="receipt-entry-link"
                            title="فتح قيد الاستلام"
                            to={`/companies/${companyId}/financial-documents/${item.receiptDocumentId}`}>
                            القيد
                          </Link>
                        : canPost
                          ? <Button size="compact" disabled={pending}
                              title="استلام المبلغ مطابقًا"
                              onClick={()=>exact(item)}>مطابق</Button>
                          : "—"}
                    </td>
                    <td>
                      {item.receiptId===null && item.kind==="close" && canPost
                        ? <Button size="compact" variant="secondary"
                            title="استلام جزء أو مبلغ غير مطابق"
                            disabled={pending} onClick={()=>partial(item)}>
                            جزء
                          </Button>
                        : "—"}
                    </td>
                    <td className="receipt-cell-date">
                      <bdi dir="ltr">{dateTime(item.createdAt)}</bdi>
                    </td>
                    <td title={electronic?item.walletName:item.pouchName}>
                      <span className="receipt-cell-ellipsis">
                        {electronic?item.walletName:item.pouchName}
                      </span>
                    </td>
                    <td title={item.kind==="close"
                      ? "إغلاق الوردية وجرد النقد الفعلي وترحيله للحافظة"
                      : "ترحيل عادي من صندوق الموظف إلى الحافظة"}>
                      <span className={`receipt-kind-marker ${item.kind==="close"
                        ?"receipt-kind-close":"receipt-kind-transfer"}`}>
                        {movementKind}
                      </span>
                    </td>
                    <td>
                      {item.receiptId===null
                        ? <span className="receipt-status-pending" title="بانتظار الاستلام">بانتظار</span>
                        : <button type="button" className="receipt-status-button"
                            title={statusDetails} onClick={()=>setInspected(item)}
                            aria-label={`تفاصيل استلام حركة ${item.id}`}>مستلم</button>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <div className="form-actions">
          <Button variant="secondary" disabled={page<=1||pending}
            onClick={()=>setPage(p=>Math.max(1,p-1))}>السابق</Button>
          <span>صفحة {page}</span>
          <Button variant="secondary" disabled={pending||!list.data||
            page*list.data.pageSize>=list.data.total}
            onClick={()=>setPage(p=>p+1)}>التالي</Button>
        </div>
      </Card>
      <Dialog open={!!inspected} title="تفاصيل حركة الاستلام"
        onClose={()=>setInspected(null)}>
        {inspected && (
          <div className="form-stack">
            <p><strong>الموظف:</strong> {inspected.employeeName}</p>
            <p><strong>{sourceName}:</strong> {electronic?inspected.walletName:inspected.pouchName}</p>
            <p><strong>التاريخ:</strong> <bdi dir="ltr">{dateTime(inspected.createdAt)}</bdi></p>
            <p><strong>المبلغ:</strong> <ReceiptAmount value={inspected.amount}/> ريال</p>
            <p><strong>نوع الحركة:</strong> {movementLabel(inspected.kind)}
              {inspected.kind==="close"
                ?" — جرد وإغلاق الصندوق وترحيل النقد إلى الحافظة."
                : inspected.kind==="pouch"
                  ?" — ترحيل مبلغ عادي من الصندوق دون إغلاقه."
                  :" — ترحيل إلى المحفظة الإلكترونية."}
            </p>
            <p><strong>ملاحظات الحركة:</strong> {inspected.notes||"—"}</p>
            <p><strong>الحالة:</strong> {inspected.receiptId===null?"بانتظار الاستلام":"تم الاستلام"}</p>
            {inspected.receiptId!==null && (
              <>
                <p><strong>المستلم:</strong> {inspected.receiverName||"—"}</p>
                <p><strong>المبلغ المستلم:</strong> <ReceiptAmount value={inspected.receivedAmount}/> ريال</p>
                <p><strong>العجز أو الزيادة:</strong> <ReceiptAmount value={inspected.differenceAmount}/> ريال</p>
                <p><strong>ملاحظات الاستلام:</strong> {inspected.receiptNotes||"—"}</p>
                {inspected.voucherDocumentId!==null && <Link
                  to={`/companies/${companyId}/financial-documents/${inspected.voucherDocumentId}`}
                  onClick={()=>setInspected(null)}>فتح السند المرافق</Link>}
                {inspected.receiptDocumentId!==null && <Link
                  to={`/companies/${companyId}/financial-documents/${inspected.receiptDocumentId}`}
                  onClick={()=>setInspected(null)}>فتح قيد الاستلام</Link>}
              </>
            )}
            <div className="form-actions">
              <Button variant="secondary" onClick={()=>setInspected(null)}>إغلاق</Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={!!voucherDraft}
        title={voucherDraft && Number(voucherDraft.movement.amount)<0
          ? "استلام التحويل وإضافة سند قبض اختياري"
          : "استلام التحويل وإضافة سند صرف اختياري"}
        className="receipt-voucher-dialog"
        onClose={()=>{if(!pending&&!uncertain){setVoucherDraft(null);setError("");}}}>
        {voucherDraft && <div className="form-stack">
          <Notice>
            سيتم ترحيل الحركة إلى صندوقك كما هو معتاد، سواء أضفت السند أم لا.
            السند اختياري ومستقل عن قيد التحويل.
          </Notice>
          <p><strong>المبلغ:</strong> <ReceiptAmount value={voucherDraft.movement.amount}/> ريال
            {" — "}<strong>الصندوق:</strong> صندوقي
          </p>
          <Field label="الملاحظات" value={voucherDraft.notes}
            maxLength={1000} disabled={pending||uncertain}
            onChange={e=>setVoucherDraft(prev=>prev?{...prev,notes:e.target.value}:prev)}/>
          <Field label="رقم الوصل (اختياري)" value={voucherDraft.receiptNumber}
            maxLength={100} disabled={pending||uncertain}
            onChange={e=>setVoucherDraft(prev=>prev?{...prev,receiptNumber:e.target.value}:prev)}/>
          <Field label="البحث عن الحساب المقابل" type="search"
            placeholder="اسم الحساب أو رقمه"
            value={voucherDraft.search} disabled={pending||uncertain}
            onChange={e=>setVoucherDraft(prev=>prev?{...prev,search:e.target.value,accountId:""}:prev)}/>
          <Select label="الحساب المقابل" value={voucherDraft.accountId}
            disabled={pending||uncertain} onChange={e=>setVoucherDraft(prev=>prev?{
              ...prev,accountId:e.target.value}:prev)}>
            <option value="">اختر الحساب</option>
            {counterpart.data?.items.map(account=>
              <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
          </Select>
          {counterpart.isFetching && <small className="muted">جارٍ البحث عن الحسابات…</small>}
          {counterpart.error && <Notice tone="error">{errorMessage(counterpart.error)}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="form-actions receipt-voucher-dialog-actions">
            <Button disabled={pending || counterpart.isFetching ||
                (!!voucherDraft.attempt && voucherDraft.attempt!=="voucher")}
              onClick={()=>confirmTransfer(true)}>
              {pending?"جارٍ الحفظ…":"حفظ السند مع ترحيل المبلغ"}
            </Button>
            <Button variant="secondary"
              disabled={pending||voucherDraft.attempt==="voucher"}
              onClick={()=>confirmTransfer(false)}>
              ترحيل المبلغ دون سند
            </Button>
            <Button variant="ghost" disabled={pending||uncertain}
              onClick={()=>{setVoucherDraft(null);setError("");}}>إلغاء</Button>
          </div>
        </div>}
      </Dialog>
      <Dialog open={!!draft} title="استلام غير مطابق / جزء"
        onClose={()=>{if(!pending&&!uncertain){setDraft(null);setError("");}}}>
        {draft&&<form className="form-stack" onSubmit={submit}>
          <p>الحركة #{draft.movement.id} — المبلغ الأصلي: <ReceiptAmount value={draft.movement.amount}/> ريال.</p>
          <Field label="المبلغ المستلم فعليًا" money inputMode="decimal"
            value={draft.amount} required autoFocus disabled={pending||uncertain}
            onChange={event=>setDraft(previous=>previous?
              {...previous,amount:normalizeDigits(event.target.value)}:previous)}/>
          <Field label="ملاحظات الاستلام" maxLength={1000}
            value={draft.notes} disabled={pending||uncertain}
            onChange={event=>setDraft(previous=>previous?
              {...previous,notes:event.target.value}:previous)}/>
          <small className="muted">
            يمكن إدخال صفر: كامل الحركة الموجبة يصبح عجزًا، وكامل الحركة السالبة يصبح زيادة.
            لا يبقى جزء معلّق بعد اعتماد الاستلام غير المطابق، بل يُثبت الفرق محاسبيًا.
          </small>
          {error&&<Notice tone="error">{error}</Notice>}
          <div className="form-actions">
            <Button type="submit" disabled={pending}>
              {pending?"جارٍ الترحيل…":uncertain?"إعادة تأكيد الطلب نفسه":"حفظ واستلام"}
            </Button>
            <Button variant="secondary" disabled={pending||uncertain} onClick={()=>{setDraft(null);setError("");}}>إلغاء</Button>
          </div>
        </form>}
      </Dialog>
    </div>
  );
}

export function ElectronicReceiptsPage({context}:{context:CompanyContext}) {
  return <PouchReceiptsPage context={context} source="electronic"/>;
}

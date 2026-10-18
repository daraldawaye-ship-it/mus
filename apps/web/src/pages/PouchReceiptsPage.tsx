import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/index.ts";
import { ApiFailure, api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { Button, Card, Dialog, Field, Notice, PageHeader } from "../ui";

type Status="pending"|"received"|"all";
type Movement={
  id:number;kind:"pouch"|"close"|"electronic";employeeName:string;amount:string;
  notes:string;createdAt:string;sourceDocumentId:number;pouchName?:string;walletName?:string;
  receiptId:number|null;receiptMode:"exact"|"difference"|null;
  receivedAmount:string|null;differenceAmount:string|null;
  receiverName:string|null;receiptDocumentId:number|null;
  receiptNotes:string|null;receivedAt:string|null;
};
type Response={items:Movement[];total:number;page:number;pageSize:number};
type Draft={movement:Movement;amount:string;notes:string;key:string};

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
  const {user}=useSession();
  const client=useQueryClient();
  const [status,setStatus]=useState<Status>("pending");
  const [page,setPage]=useState(1);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [inspected,setInspected]=useState<Movement|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState<{documentId:number;difference:string}|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const [exactKeys,setExactKeys]=useState<Record<number,string>>({});
  const canPost=context.general||context.permissions.includes("finance.post");
  const queryKey=[endpoint,user?.id,companyId,status,page] as const;
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
  ) {
    if(pending || !canPost)return;
    setError("");setNotice(null);setPending(true);
    try {
      const body=mode==="exact"
        ? {sourceOperationId:item.id,mode,notes,idempotencyKey:key}
        : {sourceOperationId:item.id,mode,receivedAmount:normalizeDigits(amount).replace(/,/g,""),
           notes,idempotencyKey:key};
      const result=await api<{
        receipt:{id:number;documentId:number;expected:string;
          received:string;difference:string};
      }>(`/companies/${companyId}/${endpoint}`,{
        method:"POST",body,
      });
      setNotice({documentId:result.receipt.documentId,
        difference:result.receipt.difference});
      setDraft(null);setUncertain(false);
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
      setError(networkUncertain
        ? "قد تكون العملية قد تمت. أعد تأكيد الطلب نفسه دون تغيير البيانات حتى لا يتكرر الاستلام. "+errorMessage(e)
        : errorMessage(e));
    }finally{setPending(false);}
  }
  function exact(item:Movement) {
    const key=exactKeys[item.id]??crypto.randomUUID();
    setExactKeys(prev=>({...prev,[item.id]:key}));
    void postReceipt(item,"exact","", "",key);
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
      {notice&&<Notice tone="success">
        تم الاستلام وتسجيل القيد #{notice.documentId}.
        {Number(notice.difference)===0
          ? " المبلغ مطابق."
          : <> الفرق: <ReceiptAmount value={notice.difference}/> ريال في حساب العجز والزيادة.</>}
      </Notice>}
      {error&&!draft&&<Notice tone="error">{error}</Notice>}
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
          <div className="pouch-receipts-table-wrap" role="region"
            aria-label={`جدول حركات ${sourceName} — مرّر أفقيًا لعرض بقية الأعمدة`} tabIndex={0}>
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
                const movementKind = item.kind==="close"
                  ? "إغلاق صندوق"
                  : electronic ? "ترحيل إلكتروني" : "ترحيل حافظة";
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
                      {item.receiptId===null && canPost
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
                    <td title={movementKind}>
                      <span className="receipt-cell-ellipsis">{movementKind}</span>
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
            <p><strong>ملاحظات الحركة:</strong> {inspected.notes||"—"}</p>
            <p><strong>الحالة:</strong> {inspected.receiptId===null?"بانتظار الاستلام":"تم الاستلام"}</p>
            {inspected.receiptId!==null && (
              <>
                <p><strong>المستلم:</strong> {inspected.receiverName||"—"}</p>
                <p><strong>المبلغ المستلم:</strong> <ReceiptAmount value={inspected.receivedAmount}/> ريال</p>
                <p><strong>العجز أو الزيادة:</strong> <ReceiptAmount value={inspected.differenceAmount}/> ريال</p>
                <p><strong>ملاحظات الاستلام:</strong> {inspected.receiptNotes||"—"}</p>
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

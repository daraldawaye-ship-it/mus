import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/index.ts";
import { ApiFailure, api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
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

const dateTime=(value:string)=>new Intl.DateTimeFormat("ar-YE",{
  dateStyle:"short",timeStyle:"short",timeZone:"Asia/Aden",
}).format(new Date(value));

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
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
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
    setError("");setNotice("");setPending(true);
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
      setNotice(
        `تم الاستلام وتسجيل القيد #${result.receipt.documentId}.`+
        (Number(result.receipt.difference)===0?" المبلغ مطابق.":
          ` الفرق: ${formatMoney(result.receipt.difference)} ريال في حساب العجز والزيادة.`),
      );
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
          ? "التحويلات إلى محفظة الشركة الإلكترونية المحددة من ربط الحسابات. استلام مطابق أو غير مطابق إلى صندوقك، مع ترحيل الفرق إلى العجز والزيادة."
          : "حركات الحوافظ وإغلاق الصناديق التي رحّلت نقدًا إلى الحافظة. الاستلام إلى صندوقك فقط، والفرق يُرحّل إلى حساب العجز والزيادة."}
        actions={<Button variant="secondary" onClick={()=>void list.refetch()}
          disabled={list.isFetching||pending}>تحديث</Button>}/>
      {notice&&<Notice tone="success">{notice}</Notice>}
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
        description={`عدد الحركات: ${list.data?.total??"…"} — ${electronic
          ? "يشمل الترحيلات الإلكترونية الموجبة والسالبة المسجلة على حساب محفظة الشركة."
          : "يشمل التحويلات الموجبة والسالبة، والنقد المرحّل للحافظة عند إغلاق الصندوق."}`}>
        {list.isLoading&&<p>جارٍ تحميل الحركات…</p>}
        {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
        {list.data?.items.length===0&&<p className="muted">لا توجد حركات مطابقة لهذه الحالة.</p>}
        {!!list.data?.items.length&&(
          <div className="pouch-receipts-table-wrap">
            <table className="pouch-receipts-table">
              <thead><tr>
                <th>التاريخ</th><th>الموظف</th><th>{sourceName}</th>
                <th>نوع الحركة</th><th>المبلغ</th><th>ملاحظات</th>
                <th>الحالة</th><th>الاستلام / القيد</th>
              </tr></thead>
              <tbody>{list.data.items.map(item=>(
                <tr key={item.id}>
                  <td>{dateTime(item.createdAt)}</td>
                  <td>{item.employeeName}</td>
                  <td>{electronic?item.walletName:item.pouchName}</td>
                  <td>{item.kind==="close"?"إغلاق صندوق":
                    electronic?"ترحيل إلكتروني":"ترحيل حافظة"}</td>
                  <td><bdi>{formatMoney(item.amount)}</bdi> ر.ي</td>
                  <td>{item.notes||"—"}</td>
                  <td>{item.receiptId===null?"بانتظار الاستلام":
                    <><strong>تم الاستلام</strong>
                      <div className="muted">{item.receiverName}</div>
                      <div className="muted">فعلي: <bdi>{formatMoney(item.receivedAmount!)}</bdi></div>
                      {Number(item.differenceAmount)!==0&&
                        <div>الفرق: <bdi>{formatMoney(item.differenceAmount!)}</bdi></div>}
                    </>}</td>
                  <td>{item.receiptId!==null
                    ? <Link to={`/companies/${companyId}/financial-documents/${item.receiptDocumentId}`}>قيد الاستلام</Link>
                    : canPost
                      ? <div className="form-actions pouch-receipts-actions">
                          <Button size="compact" disabled={pending} onClick={()=>exact(item)}>
                            استلام مطابق
                          </Button>
                          <Button size="compact" variant="secondary" disabled={pending}
                            onClick={()=>partial(item)}>استلام غير مطابق / جزء</Button>
                        </div>
                      : "يلزم صلاحية الترحيل"}
                  </td>
                </tr>
              ))}</tbody>
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
      <Dialog open={!!draft} title="استلام غير مطابق / جزء"
        onClose={()=>{if(!pending&&!uncertain){setDraft(null);setError("");}}}>
        {draft&&<form className="form-stack" onSubmit={submit}>
          <p>الحركة #{draft.movement.id} — المبلغ الأصلي: <bdi>{formatMoney(draft.movement.amount)}</bdi> ريال.</p>
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

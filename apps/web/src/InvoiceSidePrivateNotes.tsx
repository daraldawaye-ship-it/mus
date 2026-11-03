import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Notice } from "./ui";
import { UserMenuQuickCompose } from "./UserMenuQuickCompose";

type Note={id:number;title:string;body:string;createdAt:string;archivedAt:string|null};
type NotePage={items:Note[];total:number;page:number;pageSize:number};

/** Notes from the existing avatar (+), private to the signed-in account. */
export function InvoiceSidePrivateNotes() {
  const {user}=useSession();
  const queryClient=useQueryClient();
  const [archived,setArchived]=useState(false);
  const [page,setPage]=useState(1);
  const [creating,setCreating]=useState(false);
  const [workingId,setWorkingId]=useState<number|null>(null);
  const [failure,setFailure]=useState("");
  const offline=isOfflineNow();
  const key=["private-notes",user?.id,archived,page];
  const notes=useQuery<NotePage>({
    queryKey:key,
    queryFn:({signal})=>api<NotePage>(
      "/private-notes?archived="+(archived?"1":"0")+"&page="+page+"&pageSize=20",
      {signal},
    ),
    enabled:!!user&&!offline,
    staleTime:5_000,
    refetchOnWindowFocus:true,
  });
  const changeView=(value:boolean)=>{setArchived(value);setPage(1);setFailure("");};
  const update=async(note:Note)=>{
    if(workingId!==null||offline)return;
    setWorkingId(note.id);setFailure("");
    try{
      await api("/private-notes/"+note.id+"/"+(archived?"restore":"archive"),{
        method:"PATCH",body:{},
      });
      await queryClient.invalidateQueries({queryKey:["private-notes",user?.id]});
      if(page>1 && notes.data?.items.length===1)setPage(value=>Math.max(1,value-1));
    }catch(cause){setFailure(errorMessage(cause));}
    finally{setWorkingId(null);}
  };
  return <section className="invoice-side-private-notes" aria-label="ملاحظاتي الخاصة">
    <div className="invoice-side-private-actions">
      <div role="group" aria-label="حالة الملاحظات">
        <button type="button" className={!archived?"is-selected":""}
          onClick={()=>changeView(false)}>النشطة</button>
        <button type="button" className={archived?"is-selected":""}
          onClick={()=>changeView(true)}>الأرشيف</button>
      </div>
      <button type="button" className="invoice-side-private-add"
        aria-label="إضافة ملاحظة خاصة جديدة" title="إضافة ملاحظة جديدة"
        onClick={()=>setCreating(true)}>+</button>
    </div>
    {offline&&<small>الملاحظات تحتاج إلى اتصال لعرض أحدث نسخة وحفظها.</small>}
    {notes.isLoading&&!offline&&<small>جارٍ تحميل ملاحظاتك الخاصة…</small>}
    {notes.isError&&!offline&&<Notice tone="error">تعذر تحميل ملاحظاتك. <Button
      type="button" variant="secondary" size="compact" onClick={()=>void notes.refetch()}>
        إعادة المحاولة</Button></Notice>}
    {failure&&<small role="alert">{failure}</small>}
    {notes.data?.items.length===0&&!notes.isFetching&&!offline&&
      <small>{archived?"لا توجد ملاحظات مؤرشفة.":"لا توجد ملاحظات نشطة. اضغط + لإضافة أول ملاحظة."}</small>}
    <div className="invoice-side-private-list">
      {(notes.data?.items??[]).map(note=><article key={note.id} className="invoice-side-private-card">
        <div className="invoice-side-private-card-heading">
          <strong>{note.title}</strong>
          <button type="button" disabled={workingId!==null||offline}
            aria-label={(archived?"استعادة":"أرشفة")+" الملاحظة "+note.title}
            onClick={()=>void update(note)}>{workingId===note.id?"جارٍ…":archived?"استعادة":"أرشفة"}</button>
        </div>
        <p>{note.body}</p>
        <small>{new Date(note.createdAt).toLocaleString("ar-YE",{timeZone:"Asia/Aden"})}</small>
      </article>)}
    </div>
    {!!notes.data&&notes.data.total>notes.data.pageSize&&
      <div className="invoice-side-private-pagination">
        <button type="button" disabled={page===1} onClick={()=>setPage(n=>Math.max(1,n-1))}>السابق</button>
        <span>{page} / {Math.ceil(notes.data.total/notes.data.pageSize)}</span>
        <button type="button" disabled={page*notes.data.pageSize>=notes.data.total}
          onClick={()=>setPage(n=>n+1)}>التالي</button>
      </div>}
    {creating&&<UserMenuQuickCompose kind="private_note" companyId={null}
      onClose={()=>setCreating(false)} />}
  </section>;
}

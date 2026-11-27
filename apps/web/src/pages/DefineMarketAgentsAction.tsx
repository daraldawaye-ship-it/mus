import {useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {api,useScopeGuard,useSession} from "../api";
import {PageActionsDropdown} from "../SalesHeaderActionsDropdown";
import {Button,Dialog,Notice} from "../ui";

const path = "/medicine-market/owner/define-agents";
type Preview = {total:number;maxId:number};
type Batch = {items:{cardId:number}[];nextCursor:number|null;skipped:number};

export function DefineMarketAgentsAction() {
  const {user,visitorOnly,employeePreview} = useSession();
  const guard = useScopeGuard("market:define-agents");
  const client = useQueryClient();
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const pending=useRef(false), stop=useRef(false);
  const [saved,setSaved]=useState(0);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const allowed=!!user?.owner && !visitorOnly && !employeePreview;
  const preview=useQuery({
    queryKey:["medicine-market",user?.id,"define-agents-preview"],
    queryFn:({signal})=>api<Preview>(path,{signal}),
    enabled:allowed && open && !busy,
  });
  async function apply(){
    const target=preview.data;
    if(!target?.total || pending.current)return;
    pending.current=true;stop.current=false;setBusy(true);setSaved(0);setError("");setMessage("");
    let after=0,done=0,skipped=0;
    try{
      while(!stop.current && guard.isCurrent()){
        const result=await api<Batch>(path,{method:"POST",body:{after,maxId:target.maxId,limit:30},signal:guard.signal});
        if(!guard.isCurrent())return;
        done+=result.items.length;skipped+=result.skipped;setSaved(done);
        if(result.nextCursor===null)break;
        if(result.nextCursor<=after)throw new Error("تعذر متابعة مؤشر الدفعة");
        after=result.nextCursor;
      }
      if(guard.isCurrent())setMessage((stop.current?"توقّف التنفيذ. ":"انتهى التنفيذ. ")+
        `رُبط ${done} صنفًا.`+(skipped?` تُرك ${skipped} لتغيّر بياناتها أثناء التنفيذ.`:""));
    }catch{
      if(guard.isCurrent())setError("تعذّر إكمال كل الدفعات. حدّث المعاينة قبل استئناف المتبقي؛ لن تُستبدل الروابط المحفوظة.");
    }finally{
      pending.current=false;
      if(guard.isCurrent()){
        setBusy(false);
        void client.invalidateQueries({queryKey:["medicine-market",user?.id]});
      }
    }
  }
  if(!allowed)return null;
  return <>
    <PageActionsDropdown label="إجراءات" actions={[{label:"تعريف الوكلاء",onClick:()=>{
      setMessage("");setError("");setOpen(true);void preview.refetch();
    }}]}/>
    <Dialog open={open} title="تعريف الوكلاء" onClose={()=>{if(!busy)setOpen(false);}}
      footer={busy?<Button onClick={()=>{stop.current=true;}} variant="secondary">إيقاف بعد الدفعة الحالية</Button>
        : <Button onClick={()=>void apply()} disabled={!preview.data?.total||preview.isFetching}>ربط الأصناف</Button>}>
      <p>يرتبط الصنف المنشور غير المؤرشف بوكيل شركته المصنّعة فقط إذا كانت خانة وكيله فارغة.</p>
      {preview.isFetching&&!busy ? <Notice>جارٍ حصر الأصناف المؤهلة…</Notice>
        : preview.isError ? <Notice tone="error">تعذر حصر الأصناف. أغلق النافذة وأعد فتحها.</Notice>
        : <p>الأصناف المؤهلة: <strong>{preview.data?.total??0}</strong></p>}
      {busy&&<Notice>جارٍ الربط. تم حفظ {saved} صنفًا.</Notice>}
      {message&&<Notice tone="success">{message}</Notice>}
      {error&&<Notice tone="error">{error}</Notice>}
    </Dialog>
  </>;
}

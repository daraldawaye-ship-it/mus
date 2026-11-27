import {useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {api,useScopeGuard,useSession} from "../api";
import {PageActionsDropdown} from "../SalesHeaderActionsDropdown";
import {Button,Dialog,Notice} from "../ui";

const paths = { medicines:"/medicine-market/owner/define-agents", manufacturers:"/medicine-market/owner/define-manufacturer-agents" };
type Preview = {total:number;maxId:number;conflicts?:number;invalidSources?:number};
type Batch = {items:{cardId:number}[];nextCursor:number|null;skipped:number};

export function DefineMarketAgentsAction() {
  const {user,visitorOnly,employeePreview} = useSession();
  const guard = useScopeGuard("market:define-agents");
  const client = useQueryClient();
  const [direction,setDirection] = useState<keyof typeof paths>("medicines");
  const reverse = direction==="manufacturers";
  const path = paths[direction];
  const subject = reverse?"مصنّع":"صنف";
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const pending=useRef(false), stop=useRef(false);
  const [saved,setSaved]=useState(0);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const allowed=!!user?.owner && !visitorOnly && !employeePreview;
  const preview=useQuery({
    queryKey:["medicine-market",user?.id,"define-agents-preview",direction],
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
        `تم الربط: ${done} ${subject}.`+(skipped?` تُرك ${skipped} لتغيّر بياناتها أثناء التنفيذ.`:""));
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
    <PageActionsDropdown label="إجراءات" actions={([
      ["medicines","تعريف الوكلاء"],["manufacturers","تعريف وكلاء المصنّعين"]
    ] as const).map(([key,label])=>({label,onClick:()=>{
      setDirection(key);setMessage("");setError("");setSaved(0);setOpen(true);
    }}))}/>
    <Dialog open={open} title={reverse?"تعريف وكلاء المصنّعين":"تعريف الوكلاء"} onClose={()=>{if(!busy)setOpen(false);}}
      footer={busy?<Button onClick={()=>{stop.current=true;}} variant="secondary">إيقاف بعد الدفعة الحالية</Button>
        : <Button onClick={()=>void apply()} disabled={!preview.data?.total||preview.isFetching}>{reverse?"ربط المصنّعين":"ربط الأصناف"}</Button>}>
      <p>{reverse
        ?"يمتلئ وكيل المصنّع المنشور غير المؤرشف إذا كانت الخانة فارغة وأشارت أصنافه المنشورة غير المؤرشفة إلى وكيل واحد صالح."
        :"يرتبط الصنف المنشور غير المؤرشف بوكيل شركته المصنّعة فقط إذا كانت خانة وكيله فارغة."}</p>
      {preview.isFetching&&!busy ? <Notice>جارٍ حصر الأصناف المؤهلة…</Notice>
        : preview.isError ? <Notice tone="error">تعذر حصر الأصناف. أغلق النافذة وأعد فتحها.</Notice>
        : <p>{reverse?"المصنّعون المؤهلون:":"الأصناف المؤهلة:"} <strong>{preview.data?.total??0}</strong></p>}
      {reverse&&preview.data&&<p>للمراجعة دون تعديل: {preview.data.conflicts??0} أكثر من وكيل، و{preview.data.invalidSources??0} وكيل غير صالح.</p>}
      {busy&&<Notice>جارٍ الربط. تم الحفظ: {saved} {subject}.</Notice>}
      {message&&<Notice tone="success">{message}</Notice>}
      {error&&<Notice tone="error">{error}</Notice>}
    </Dialog>
  </>;
}

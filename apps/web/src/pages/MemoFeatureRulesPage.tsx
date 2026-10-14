import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import type {CompanyContext,MemoFeatureRule,MemoFeaturePreview,MemoRecipient} from "../../../../packages/contracts/src/index";
import {api,useSession} from "../api";
import {Button,Card,Field,Select,Notice,PageHeader} from "../ui";
import {errorMessage} from "../phase2";

type Draft=Omit<MemoFeatureRule,"id"|"companyId"|"revision"|"changedAt">;
const initial=():Draft=>({
 name:"",enabled:false,employeeIds:[],roleIds:[],actionCode:"invoice.sale.create",
 effect:"monitor",minimumCount:3,minimumHours:48,matchMode:"all",
 excludeDeferredUntilDue:true,message:"توجد تكليفات تحتاج متابعتك. افتح «مطلوب مني».",
});
export function MemoFeatureRulesPage({context}:{context:CompanyContext}){
 const companyId=context.company.id,{user}=useSession(),client=useQueryClient(),
  base=`/companies/${companyId}`;
 const [editing,setEditing]=useState<number|null>(null);
 const [draft,setDraft]=useState<Draft>(initial());
 const [saving,setSaving]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [previewId,setPreviewId]=useState<number|null>(null);
 const rules=useQuery({queryKey:["memo-feature-rules",user?.id,companyId],
  queryFn:({signal})=>api<{rules:MemoFeatureRule[]}>(`${base}/memo-feature-rules`,{signal}),
  enabled:!!user&&context.general});
 const roles=useQuery({queryKey:["memo-feature-roles",user?.id,companyId],
  queryFn:({signal})=>api<{roles:{id:number;name:string}[]}>(`${base}/memos/roles`,{signal}),
  enabled:!!user&&context.general});
 const employees=useQuery({queryKey:["memo-feature-employees",user?.id,companyId],
  queryFn:({signal})=>api<{items:MemoRecipient[]}>(`${base}/memos/recipients?pageSize=100`,{signal}),
  enabled:!!user&&context.general});
 const preview=useQuery({queryKey:["memo-feature-preview",user?.id,companyId,previewId],
  queryFn:({signal})=>api<MemoFeaturePreview>(`${base}/memo-feature-rules/${previewId}/preview`,{signal}),
  enabled:previewId!==null&&context.general});
 function editRule(rule?:MemoFeatureRule){
  setEditing(rule?.id??0);setPreviewId(null);setError("");setNotice("");
  setDraft(rule?{
   name:rule.name,enabled:rule.enabled,employeeIds:rule.employeeIds,
   roleIds:rule.roleIds,actionCode:rule.actionCode,effect:rule.effect,
   minimumCount:rule.minimumCount,minimumHours:rule.minimumHours,
   matchMode:rule.matchMode,excludeDeferredUntilDue:rule.excludeDeferredUntilDue,
   message:rule.message,
  }:initial());
 }
 async function save(){
  if(editing===null||saving)return;
  setSaving(true);setError("");setNotice("");
  const previous=rules.data?.rules.find(rule=>rule.id===editing);
  try{
   await api(`${base}/memo-feature-rules${previous?"/"+previous.id:""}`,{
     method:previous?"PUT":"POST",
     body:{...draft,...(previous?{revision:previous.revision}:{})},
   });
   setEditing(null);setNotice("تم حفظ القاعدة. يظهر تأثيرها في المعاينة.");
   await client.invalidateQueries({queryKey:["memo-feature-rules",user?.id,companyId]});
  }catch(cause){setError(errorMessage(cause));}
  finally{setSaving(false);}
 }
 function toggle(kind:"employeeIds"|"roleIds",value:number){
  setDraft(previous=>({...previous,[kind]:previous[kind].includes(value)
    ?previous[kind].filter(id=>id!==value):[...previous[kind],value]}));
 }
 return <div className="wallet-page">
  <PageHeader title="قواعد ميزات المذكرات" description="المراقبة والتنبيه على إجراءات الموقع حسب المذكرات المعلقة"
   actions={<Link className="button button-secondary" to={`${base}/memo-report`}>تقرير المذكرات</Link>}/>
  {!context.general&&<Notice tone="warning">إدارة هذه القواعد للمدير العام أو المالك فقط.</Notice>}
  {error&&<Notice tone="error">{error}</Notice>}
  {notice&&<Notice tone="success">{notice}</Notice>}
  {context.general&&<Card title="القواعد الحالية">
   <Button variant="secondary" onClick={()=>editRule()}>قاعدة جديدة</Button>
   <div className="table-scroll"><table><thead><tr>
    <th>الاسم</th><th>الإجراء</th><th>الأثر</th><th>التفعيل</th><th>تعديل</th><th>معاينة</th>
   </tr></thead><tbody>
    {rules.data?.rules.map(rule=><tr key={rule.id}>
     <td>{rule.name}</td><td>{rule.actionCode==="invoice.sale.create"?"إنشاء فاتورة مبيعات":"إنشاء فاتورة مشتريات"}</td>
     <td>{rule.effect==="monitor"?"مراقبة":rule.effect==="warn"?"تنبيه":"منع"}</td>
     <td>{rule.enabled?"مفعلة":"متوقفة"}</td>
     <td><Button variant="secondary" onClick={()=>editRule(rule)}>تعديل</Button></td>
     <td><Button variant="secondary" onClick={()=>setPreviewId(rule.id)}>معاينة المشمولين</Button></td>
    </tr>)}
   </tbody></table></div>
  </Card>}
  {editing!==null && <Card title="بيانات القاعدة">
   <Field label="اسم القاعدة" value={draft.name}
    onChange={e=>setDraft({...draft,name:e.target.value})}/>

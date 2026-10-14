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

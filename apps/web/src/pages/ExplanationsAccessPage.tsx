import { useEffect,useState } from "react";
import { Link } from "react-router-dom";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { api,useSession } from "../api";
import { Button,Card,Notice,PageHeader,Select } from "../ui";
import { errorMessage } from "../phase2";

type Rule={users:number[];kinds:string[]}|null;
type Group={id:number;slug:string;title:string;canEdit:boolean;defaultRead:Rule;defaultEdit:Rule};
type Person={id:number;name:string;kind:string};
type Role="none"|"viewer"|"editor";
const usersIn=(rule:Rule)=>rule?.users??[];
const grantFor=(group:Group,personId:number):Role=>{
 if(usersIn(group.defaultEdit).includes(personId))return "editor";
 if(usersIn(group.defaultRead).includes(personId))return "viewer";
 return "none";
};
function setGrant(rule:Rule,personId:number,on:boolean):Rule {
 const existing=rule??{users:[],kinds:[]};
 const users=existing.users.filter(id=>id!==personId);
 if(on)users.push(personId);
 return users.length||existing.kinds.length?{...existing,users}:null;
}
export function ExplanationsAccessPage() {
 const {user}=useSession();
 const client=useQueryClient();
 const groups=useQuery({queryKey:["explanations","groups",user?.id],
   queryFn:()=>api<{items:Group[]}>("/explanations/groups"),enabled:!!user?.owner});
 const people=useQuery({queryKey:["explanations","access-users",user?.id],
   queryFn:()=>api<{items:Person[]}>("/explanations/users"),enabled:!!user?.owner});
 const [groupId,setGroupId]=useState(0),[personId,setPersonId]=useState(0);
 const group=groups.data?.items.find(g=>g.id===groupId)??groups.data?.items[0];
 const allPeople=people.data?.items.filter(p=>p.id!==user?.id)??[];
 const person=allPeople.find(p=>p.id===personId)??allPeople[0];
 const currentPerson=person?.id??0;
 const [role,setRole]=useState<Role>("none");
 const [saving,setSaving]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 useEffect(()=>{setRole(group&&currentPerson?grantFor(group,currentPerson):"none");},
  [group?.id,group?.defaultRead,group?.defaultEdit,currentPerson]);
 if(!user?.owner)return <Notice tone="error">منح صلاحيات صفحات الشروح متاح لمالك المنصة فقط.</Notice>;
 const save=async()=>{
  if(!group||!person||saving)return;
  setSaving(true);setError("");setMessage("");
  try{
   const read=setGrant(group.defaultRead,person.id,role==="viewer");
   const edit=setGrant(group.defaultEdit,person.id,role==="editor");
   await api("/explanations/groups/"+group.id,{method:"PATCH",body:{
     title:group.title,defaultRead:read,defaultEdit:edit,
   }});
   await client.invalidateQueries({queryKey:["explanations"]});
   setMessage(role==="none"?"أُلغيت صلاحيات المستخدم على هذه المجموعة.":
     role==="viewer"?"مُنحت صلاحية القراءة دون التعديل.":"مُنحت صلاحيتا القراءة والإضافة والتعديل.");
  }catch(reason){setError(errorMessage(reason));}
  finally{setSaving(false);}
 };
 const grants=group?allPeople.map(p=>({person:p,role:grantFor(group,p.id)}))
   .filter(item=>item.role!=="none"):[];
 return <section className="explain-access-page" dir="rtl" style={{display:"grid",gap:12}}>
  <PageHeader title="منح صلاحيات صفحات الشروح"
   description="المالك وحده يحدد من يدخل صفحة القراءة ومن يضيف ويعدل الشروح. غير المفوضين لا يستطيعون فتح الصفحات أو طلب البيانات."
   actions={<Link className="button button-secondary" to="/pages">قائمة صفحات الموقع</Link>}/>
  <Card title="اختيار الصفحة والمستخدم">
   <p>القراءة تفتح صفحة العرض والطباعة فقط. التعديل يشمل القراءة وإضافة السجلات والمرفقات وتعديلها ضمن المجموعة؛ وتبقى أي قيود أكثر خصوصية على السجلات سارية.</p>
   <div className="form-grid">
    <Select label="مجموعة الشروح" value={group?.id??""}
      onChange={e=>{setGroupId(Number(e.target.value));setMessage("");setError("");}}>
     {(groups.data?.items??[]).map(g=><option key={g.id} value={g.id}>{g.title}</option>)}
    </Select>
    <Select label="المستخدم" value={currentPerson||""}
      onChange={e=>{setPersonId(Number(e.target.value));setMessage("");setError("");}}>
     {allPeople.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
    <Select label="صلاحيات هذا المستخدم" value={role}
      onChange={e=>{setRole(e.target.value as Role);setMessage("");}}>
     <option value="none">لا توجد صلاحية — المالك فقط</option>
     <option value="viewer">القراءة والطباعة فقط</option>
     <option value="editor">القراءة والإضافة والتعديل</option>
    </Select>
   </div>
   <div className="actions" style={{marginTop:12}}>
    <Button disabled={!group||!person||saving||role===grantFor(group!,currentPerson)} onClick={()=>void save()}>
     {saving?"جارٍ الحفظ…":"حفظ صلاحيات المستخدم"}
    </Button>
   </div>
   {groups.isPending&&<Notice>جارٍ تحميل مجموعات الشروح…</Notice>}
   {people.isPending&&<Notice>جارٍ تحميل المستخدمين…</Notice>}
   {groups.error&&<Notice tone="error">{errorMessage(groups.error)}</Notice>}
   {people.error&&<Notice tone="error">{errorMessage(people.error)}</Notice>}
   {error&&<Notice tone="error">{error}</Notice>}
   {message&&<Notice tone="success">{message}</Notice>}
  </Card>
  {group&&<Card title={"الصلاحيات الممنوحة — "+group.title}>
   {grants.length===0?<p>لا يوجد مستخدم آخر مفوض حاليًا؛ الوصول للمالك فقط.</p>:
    <div style={{display:"grid",gap:8}}>{grants.map(item=>
     <div key={item.person.id} style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",borderBottom:"1px solid var(--border)",paddingBlock:6}}>
      <strong style={{flex:1}}>{item.person.name}</strong>
      <span>{item.role==="editor"?"قراءة وإضافة وتعديل":"قراءة وطباعة"}</span>
      <Button size="compact" variant="secondary" onClick={()=>{setPersonId(item.person.id);setRole(item.role);}}>تعديل الصلاحية</Button>
     </div>)}</div>}
   <p className="muted">صلاحيات الأدوار العامة والقيود الخاصة بكل سجل تُدار من إعدادات المجموعة والسجل. لا تُمنح أي صلاحية افتراضية لجميع المستخدمين.</p>
  </Card>}
  <Card title="روابط الصفحات">
   <div className="actions">
    <Link className="button button-secondary" to={"/explanations/topics?group="+encodeURIComponent(group?.slug??"mustafa-cases")}>صفحة قراءة الشروح</Link>
    <Link className="button button-secondary" to={"/explanations?group="+encodeURIComponent(group?.slug??"mustafa-cases")}>صفحة الإضافة والتعديل</Link>
    <Link className="button button-secondary" to="/pages">إدارة صفحات الموقع</Link>
   </div>
  </Card>
 </section>;
}

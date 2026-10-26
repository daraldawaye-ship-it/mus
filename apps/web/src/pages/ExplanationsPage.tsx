import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import { errorMessage } from "../phase2";
import "./ExplanationsPage.css";

type Acl={users:number[];kinds:("admin"|"supervisor"|"member")[]}|null;
type Group={id:number;slug:string;title:string;canEdit:boolean;defaultRead:Acl;defaultEdit:Acl};
type Node={id:number;groupId:number;parentId:number|null;position:number;kind:"heading"|"paragraph";title:string;preview:string;color:string|null;fontSize:number|null;readAcl:Acl;editAcl:Acl;canEdit:boolean};
type Detail={record:Node&{body:string;evidence:string};assets:{id:number;filename:string;displayName:string;mimeType:string}[]};
type Person={id:number;name:string;kind:string};
type Draft={title:string;body:string;evidence:string;kind:"heading"|"paragraph";color:string|null;fontSize:number|null;readAcl:Acl;editAcl:Acl};
type Insertion={groupId:number;parentId:number|null;afterId:number|null};
const blank=(kind:"heading"|"paragraph"="paragraph"):Draft=>({title:"",body:"",evidence:"",kind,color:null,fontSize:null,readAcl:null,editAcl:null});
const kinds=[{value:"admin",name:"إدارة"},{value:"supervisor",name:"مشرف"},{value:"member",name:"مستخدم"}] as const;
function AclField({title,value,onChange,people}:{title:string;value:Acl;onChange:(acl:Acl)=>void;people:Person[]}) {
 return <div className="explain-acl"><Select label={title} value={value===null?"inherit":"custom"} onChange={e=>onChange(e.target.value==="inherit"?null:{users:[],kinds:[]})}>
 <option value="inherit">الافتراضي — يرث صلاحيات الأب</option><option value="custom">اختيار مستخدمين أو أدوار</option></Select>
 {value!==null&&<div className="explain-choices">
 <div className="explain-choice-title">الأدوار</div>
 {kinds.map(k=><label key={k.value}><input type="checkbox" checked={value.kinds.includes(k.value)}
 onChange={e=>onChange({...value,kinds:e.target.checked?[...value.kinds,k.value]:value.kinds.filter(v=>v!==k.value)})}/>{k.name}</label>)}
 <div className="explain-choice-title">المستخدمون المحددون</div>
 {people.length===0&&<small>قائمة المستخدمين متاحة للمالك فقط.</small>}
 <div className="explain-people">{people.map(p=><label key={p.id}><input type="checkbox" checked={value.users.includes(p.id)}
 onChange={e=>onChange({...value,users:e.target.checked?[...value.users,p.id]:value.users.filter(v=>v!==p.id)})}/>{p.name}</label>)}</div>
 </div>}
 </div>;
}
function DetailView({nodeId,canEdit,onEdit,onChanged}:{nodeId:number;canEdit:boolean;onEdit:()=>void;onChanged:()=>void}) {
 const [error,setError]=useState(""),[busy,setBusy]=useState(false);
 const detail=useQuery({queryKey:["explanations","detail",nodeId],queryFn:()=>api<Detail>("/explanations/nodes/"+nodeId)});
 const [renaming,setRenaming]=useState<number|null>(null);
 const upload=async(files:FileList|null)=>{
  if(!files?.length)return;
  setBusy(true);setError("");
  try {
   for(const file of Array.from(files)){
    if(file.size>10*1024*1024)throw new Error("يتجاوز الملف "+file.name+" الحد التقني 10MB.");
    if(!["application/pdf","image/png","image/jpeg","image/webp"].includes(file.type))
      throw new Error("صيغة الملف "+file.name+" غير مدعومة.");
    const dataUrl=await new Promise<string>((resolve,reject)=>{
     const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("تعذر قراءة "+file.name));reader.readAsDataURL(file);
    });
    await api("/explanations/nodes/"+nodeId+"/assets",{method:"POST",body:{filename:file.name,displayName:file.name,dataUrl}});
   }
   await detail.refetch();onChanged();
  }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
 };
 const rename=async(assetId:number,oldName:string)=>{
  const value=window.prompt("اسم الصورة الذي يظهر في الشرح:",oldName)?.trim();
  if(!value || value===oldName)return;
  setRenaming(assetId);setError("");
  try{await api("/explanations/assets/"+assetId,{method:"PATCH",body:{displayName:value}});await detail.refetch();}
  catch(e){setError(errorMessage(e));}finally{setRenaming(null);}
 };
 const remove=async(assetId:number)=>{
  if(!window.confirm("حذف هذا المرفق؟"))return;
  setRenaming(assetId);setError("");
  try{await api("/explanations/assets/"+assetId,{method:"DELETE"});await detail.refetch();}
  catch(e){setError(errorMessage(e));}finally{setRenaming(null);}
 };
 return <div className="explain-detail">
  {detail.isPending&&<small>جارٍ تحميل الشرح…</small>}
  {detail.error&&<Notice tone="error">{errorMessage(detail.error)}</Notice>}
  {detail.data&&<>
   <p className="explain-body" style={{color:detail.data.record.color??undefined,fontSize:detail.data.record.fontSize??undefined}}>{detail.data.record.body||"لا يوجد شرح نصي."}</p>
   {detail.data.record.evidence&&<p className="explain-body"><strong>وجه الاستدلال:</strong> {detail.data.record.evidence}</p>}
   {detail.data.assets.length>0&&<div className="explain-attachment-list">
    {detail.data.assets.map(a=><div className="explain-attachment" key={a.id}>
     <span>{a.mimeType==="application/pdf"?"📄":"🖼️"}</span>
     <a href={"/api/explanations/assets/"+a.id} target="_blank" rel="noreferrer" title={a.filename}>{a.displayName||a.filename}</a>
     {canEdit&&<><Button size="compact" variant="secondary" disabled={renaming!==null} onClick={()=>void rename(a.id,a.displayName||a.filename)}>تسمية</Button>
      <Button size="compact" variant="danger" disabled={renaming!==null} onClick={()=>void remove(a.id)}>حذف</Button></>}
    </div>)}
   </div>}
   {canEdit&&<div className="explain-actions">
    <Button size="compact" variant="secondary" onClick={onEdit}>تعديل الشرح والصلاحيات</Button>
    <label className="button button-secondary button-compact">إضافة صور وPDF
      <input hidden multiple type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={busy}
       onChange={e=>{void upload(e.target.files);e.target.value="";}}/></label>
   </div>}
  </>}
  {busy&&<Notice>جارٍ حفظ المرفقات المختارة…</Notice>}
  {error&&<Notice tone="error">{error}</Notice>}
 </div>;
}
function ExplanationNode({node,children,number,root,onAdd,onEdit,onDelete,onChanged}:{
 node:Node;number:string;root:Node;children:ReactNode;onAdd:(where:Insertion,kind:"heading"|"paragraph")=>void;
 onEdit:(node:Node)=>void;onDelete:(node:Node)=>void;onChanged:()=>void;
}) {
 const [open,setOpen]=useState(false),[details,setDetails]=useState(false);
 return <article className={"explain-node "+(node.kind==="heading"?"explain-heading":"explain-paragraph")}>
  <div className="explain-row">
   <button type="button" className="explain-open" onClick={()=>{setOpen(!open);setDetails(!details);}} aria-expanded={open}>
    <span className="explain-num">{number}</span>
    <span style={{color:node.color??undefined,fontSize:node.fontSize??undefined}}>{node.title || (node.kind==="paragraph"?(node.preview+(node.preview.length>=180?"…":"")):"عنوان دون تسمية")}</span>
    <span aria-hidden="true">{open?"▾":"◂"}</span>
   </button>
   {node.canEdit&&<details className="explain-menu"><summary>الإجراءات</summary><div className="explain-menu-options">
    <button onClick={()=>onAdd({groupId:node.groupId,parentId:node.parentId,afterId:node.id},"paragraph")}>إضافة سجل بعده</button>
    <button onClick={()=>onAdd({groupId:node.groupId,parentId:null,afterId:root.id},"heading")}>إضافة عنوان رئيسي بعده</button>
    <button onClick={()=>onAdd({groupId:node.groupId,parentId:root.id,afterId:node.parentId===root.id?node.id:null},"heading")}>إضافة فرعي 1</button>
    {node.id!==root.id&&<button onClick={()=>onAdd({groupId:node.groupId,parentId:node.id,afterId:null},"heading")}>إضافة عنوان فرعي 2</button>}
    <button onClick={()=>onAdd({groupId:node.groupId,parentId:node.id,afterId:null},"paragraph")}>إضافة سجل تحته</button>
    {node.id===root.id&&<Link to={"/explanations/topic/"+node.id}>عرض الموضوع كورقة</Link>}
    <button onClick={()=>onEdit(node)}>تعديل وصلاحيات</button>
    <button onClick={()=>onDelete(node)}>حذف السجل</button>
   </div></details>}
  </div>
  {open&&<div className="explain-child">
    {details&&<DetailView nodeId={node.id} canEdit={node.canEdit} onEdit={()=>onEdit(node)} onChanged={onChanged}/>}
    {children}
  </div>}
 </article>;
}
export function ExplanationsPage() {
 const {user}=useSession(),client=useQueryClient(),[params,setParams]=useSearchParams();
 const [editor,setEditor]=useState<{id:number|null;where:Insertion}|null>(null);
 const [draft,setDraft]=useState<Draft>(blank());
 const [notice,setNotice]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [newGroup,setNewGroup]=useState(false),[newGroupName,setNewGroupName]=useState(""),[newGroupSlug,setNewGroupSlug]=useState("");
 const [editGroup,setEditGroup]=useState(false),[groupDraft,setGroupDraft]=useState<{title:string;defaultRead:Acl;defaultEdit:Acl}|null>(null);
 const groups=useQuery({queryKey:["explanations","groups",user?.id],queryFn:()=>api<{items:Group[]}>("/explanations/groups"),enabled:!!user});
 const group=groups.data?.items.find(g=>g.slug===(params.get("group")||"mustafa-cases"))??groups.data?.items[0];
 const tree=useQuery({queryKey:["explanations","tree",user?.id,group?.id],queryFn:()=>api<{group:Group;items:Node[]}>("/explanations/groups/"+group!.id+"/tree"),enabled:!!group});
 const persons=useQuery({queryKey:["explanations","users",user?.id],queryFn:()=>api<{items:Person[]}>("/explanations/users"),enabled:!!user?.owner});
 const people=persons.data?.items??[];
 const all=tree.data?.items??[],byId=new Map(all.map(n=>[n.id,n])),byParent=new Map<number|null,Node[]>();
 for(const n of all){const rows=byParent.get(n.parentId)??[];rows.push(n);byParent.set(n.parentId,rows);}
 function renderNodes(parentId:number|null,prefix="",root?:Node):ReactNode{
  return (byParent.get(parentId)??[]).map((n,index)=>{
   const number=prefix?prefix+"."+(index+1):String(index+1);
   return <ExplanationNode key={n.id} node={n} number={number} root={root??n}
     onAdd={beginInsert} onEdit={beginEdit} onDelete={removeNode} onChanged={()=>void invalidate()}>
     {renderNodes(n.id,number,root??n)}
   </ExplanationNode>;
  });
 }
 const invalidate=()=>client.invalidateQueries({queryKey:["explanations"]});
 const run=async(job:()=>Promise<void>)=>{
  setBusy(true);setError("");setNotice("");
  try{await job();await invalidate();setNotice("تم الحفظ وتحديث الترتيب تلقائيًا.");}
  catch(e){setError(errorMessage(e));}finally{setBusy(false);}
 };
 function beginInsert(where:Insertion,kind:"heading"|"paragraph"){
  setDraft(blank(kind));setEditor({id:null,where});setError("");
 }
 async function beginEdit(node:Node) {
  setBusy(true);setError("");
  try{const result=await api<Detail>("/explanations/nodes/"+node.id);
   const r=result.record;
   setDraft({title:r.title,body:r.body,evidence:r.evidence,kind:r.kind,color:r.color,fontSize:r.fontSize,readAcl:r.readAcl,editAcl:r.editAcl});
   setEditor({id:node.id,where:{groupId:node.groupId,parentId:node.parentId,afterId:null}});
  }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
 }
 function removeNode(node:Node){
  if(!window.confirm("حذف هذا السجل؟ لا يمكن حذف عنوان يحتوي فروعًا."))return;
  void run(async()=>{await api("/explanations/nodes/"+node.id,{method:"DELETE"});});
 }
 const save=()=>void run(async()=>{
  if(!editor)return;
  if(draft.kind==="heading"&&!draft.title.trim())throw new Error("اكتب عنوانًا.");
  if(draft.kind==="paragraph"&&!draft.title.trim()&&!draft.body.trim())throw new Error("أدخل شرحًا أو عنوانًا.");
  if(editor.id===null)await api("/explanations/nodes",{method:"POST",body:{...draft,...editor.where}});
  else await api("/explanations/nodes/"+editor.id,{method:"PATCH",body:draft});
  setEditor(null);
 });
 const saveGroup=()=>void run(async()=>{
  if(newGroup){
   const result=await api<{id:number}>("/explanations/groups",{method:"POST",body:{title:newGroupName,slug:newGroupSlug,defaultRead:null,defaultEdit:null}});
   setParams({group:newGroupSlug});setNewGroup(false);setNewGroupName("");setNewGroupSlug("");void result;
  }else if(group&&groupDraft){
   await api("/explanations/groups/"+group.id,{method:"PATCH",body:groupDraft});setEditGroup(false);
  }
 });
 return <div className="explain-page">
  <PageHeader title="الشروح المنظمة" description="شروح عامة بعناوين وفروع متعددة، ترقيم تلقائي وصلاحيات مستقلة لكل سجل."
   actions={<><Link className="button button-secondary" to="/legal-cases">صفحة قضايا مصطفى</Link>
    {group?.canEdit&&<Button onClick={()=>beginInsert({groupId:group.id,parentId:null,afterId:null},"heading")}>إضافة عنوان رئيسي</Button>}
    {user?.owner&&<Button variant="secondary" onClick={()=>setNewGroup(!newGroup)}>مجموعة شروح جديدة</Button>}
   </>}/>
  {error&&<Notice tone="error">{error}</Notice>}{notice&&<Notice tone="success">{notice}</Notice>}
  {newGroup&&<Card title="مجموعة شروح جديدة"><div className="explain-actions">
    <Field label="اسم المجموعة" value={newGroupName} onChange={e=>setNewGroupName(e.target.value)}/>
    <Field label="معرف إنجليزي للرابط" value={newGroupSlug} onChange={e=>setNewGroupSlug(e.target.value)}/>
    <Button disabled={busy||!newGroupName.trim()||!newGroupSlug} onClick={saveGroup}>إنشاء</Button><Button variant="secondary" onClick={()=>setNewGroup(false)}>إلغاء</Button>
  </div></Card>}
  <div className="explain-group-switch"><label htmlFor="explain-group">مجموعة الشروح</label>
  <select id="explain-group" value={group?.slug??""} onChange={e=>{setParams({group:e.target.value});setEditor(null);}}>
   {(groups.data?.items??[]).map(g=><option key={g.id} value={g.slug}>{g.title}</option>)}
  </select>
  {group&&user?.owner&&<Button variant="secondary" size="compact" onClick={()=>{setEditGroup(true);setGroupDraft({title:group.title,defaultRead:group.defaultRead,defaultEdit:group.defaultEdit});}}>إعدادات المجموعة والصلاحيات</Button>}
  </div>
  {editGroup&&groupDraft&&<Card title="الصلاحيات الافتراضية للمجموعة">
    <Field label="الاسم" value={groupDraft.title} onChange={e=>setGroupDraft({...groupDraft,title:e.target.value})}/>
    <AclField title="صلاحيات القراءة الافتراضية" value={groupDraft.defaultRead} people={people} onChange={v=>setGroupDraft({...groupDraft,defaultRead:v})}/>
    <AclField title="صلاحيات التعديل الافتراضية" value={groupDraft.defaultEdit} people={people} onChange={v=>setGroupDraft({...groupDraft,defaultEdit:v})}/>
    <div className="explain-actions"><Button disabled={busy} onClick={saveGroup}>حفظ المجموعة</Button><Button variant="secondary" onClick={()=>setEditGroup(false)}>إلغاء</Button></div>
  </Card>}
  {editor&&<Card title={editor.id===null?"إضافة سجل":"تعديل السجل"}>
    <div className="explain-fields">
     <Select label="نوع السجل" value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value as Draft["kind"]})}>
      <option value="heading">عنوان</option><option value="paragraph">فقرة شرح</option>
     </Select>
     <Field label="العنوان (اختياري للفقرة)" value={draft.title} maxLength={500} onChange={e=>setDraft({...draft,title:e.target.value})}/>
     <label>الشرح<textarea rows={6} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
     <label>وجه الاستدلال (اختياري)<textarea rows={3} value={draft.evidence} onChange={e=>setDraft({...draft,evidence:e.target.value})}/></label>
     <label>لون الخط <input type="color" value={draft.color||"#333333"} onChange={e=>setDraft({...draft,color:e.target.value})}/><button type="button" onClick={()=>setDraft({...draft,color:null})}>تلقائي</button></label>
     <Select label="حجم الخط" value={draft.fontSize??""} onChange={e=>setDraft({...draft,fontSize:e.target.value?Number(e.target.value):null})}>
      <option value="">تلقائي</option>{[12,14,16,18,20,24,28,32].map(x=><option key={x} value={x}>{x}</option>)}
     </Select>
     <AclField title="صلاحيات القراءة" value={draft.readAcl} people={people} onChange={v=>setDraft({...draft,readAcl:v})}/>
     <AclField title="صلاحيات التعديل" value={draft.editAcl} people={people} onChange={v=>setDraft({...draft,editAcl:v})}/>
    </div>
    {editor.id!==null&&<Notice>يمكنك إضافة عدة صور أو ملفات PDF بأسمائها من قائمة مرفقات السجل بعد حفظ التعديل. لا يوجد حد لعدد الملفات.</Notice>}
    <div className="explain-actions"><Button disabled={busy} onClick={save}>{busy?"جارٍ الحفظ…":"حفظ"}</Button><Button variant="secondary" onClick={()=>setEditor(null)}>إلغاء</Button></div>
   </Card>}
  {groups.isPending&&<Notice>جارٍ تحميل مجموعات الشروح…</Notice>}
  {groups.error&&<Notice tone="error">{errorMessage(groups.error)}</Notice>}
  {groups.data?.items.length===0&&<Notice>لم تُمنح لهذا الحساب صلاحية قراءة مجموعات الشروح بعد.</Notice>}
  {tree.isPending&&group&&<Notice>جارٍ تحميل العناوين…</Notice>}
  {tree.error&&<Notice tone="error">{errorMessage(tree.error)}</Notice>}
  {group&&<Card title={group.title}>
    <div className="explain-headline"><Link className="button button-secondary" to={"/explanations/topics?group="+encodeURIComponent(group.slug)}>عرض للمستخدمين (قائمة الموضوعات)</Link><strong>عدد السجلات: {all.length}</strong><small>اضغط عنوانًا لعرض فروعه، ثم افتح الشرح لتحميل المحتوى والمرفقات.</small></div>
    <div className="explain-tree">{renderNodes(null)}</div>
   </Card>}
 </div>;
}

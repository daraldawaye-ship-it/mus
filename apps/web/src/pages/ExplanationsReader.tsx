import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, useSession } from "../api";
import { Button, Notice, PageHeader } from "../ui";
import { errorMessage } from "../phase2";
import "./ExplanationsReader.css";

type Topic = {id:number;title:string;position:number};
type Group = {id:number;slug:string;title:string;canEdit?:boolean};
type Asset = {id:number;node_id:number;filename:string;displayName:string;mimeType:string};
type Node = {id:number;parentId:number|null;position:number;kind:"heading"|"paragraph";title:string;body:string;evidence:string;color:string|null;fontSize:number|null;assets:Asset[]};
type TopicData = {group:Group;topicId:number;topics:Topic[];nodes:Node[]};
type TopicIndex = {group:Group;topics:Topic[]};
const assetUrl=(id:number)=>"/api/explanations/assets/"+id;
const arabic=(n:number)=>new Intl.NumberFormat("ar",{useGrouping:false}).format(n);

function ImageDialog({asset,onClose}:{asset:Asset|null;onClose:()=>void}) {
 useEffect(()=>{
  if(!asset)return;
  const handler=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};
  window.addEventListener("keydown",handler);
  return ()=>window.removeEventListener("keydown",handler);
 },[asset,onClose]);
 if(!asset)return null;
 return <div className="explain-image-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
   <div className="explain-image-dialog" role="dialog" aria-modal="true" aria-label={asset.displayName||asset.filename}>
    <div className="explain-image-topbar">
      <strong>{asset.displayName||asset.filename}</strong>
      <a href={assetUrl(asset.id)} target="_blank" rel="noreferrer">فتح الصورة الأصلية</a>
      <button type="button" autoFocus onClick={onClose} aria-label="إغلاق الصورة">×</button>
    </div>
    <img src={assetUrl(asset.id)} alt={asset.displayName||asset.filename}/>
   </div>
 </div>;
}

export function ExplanationsTopicIndex() {
 const {user}=useSession();
 const [params,setParams]=useSearchParams();
 const slug=params.get("group")||"mustafa-cases";
 const groups=useQuery({queryKey:["explanations","groups",user?.id],
   queryFn:()=>api<{items:Group[]}>("/explanations/groups"),enabled:!!user});
 const group=groups.data?.items.find(g=>g.slug===slug)??groups.data?.items[0];
 const topics=useQuery({queryKey:["explanations","topics",user?.id,group?.id],
   queryFn:()=>api<TopicIndex>("/explanations/groups/"+group!.id+"/topics"),enabled:!!group});
 return <section className="explain-reader-index" dir="rtl">
  <PageHeader title="مكتبة الشروح" description="اختر عنوانًا رئيسيًا لقراءته كورقة مستقلة وطباعته."
   actions={group?.canEdit?<Link className="button button-secondary" to={"/explanations?group="+encodeURIComponent(group.slug)}>إضافة وتعديل الشروح</Link>:undefined}/>
  {groups.isPending&&<Notice>جارٍ تحميل الشروح…</Notice>}
  {groups.error&&<Notice tone="error">{errorMessage(groups.error)}</Notice>}
  {groups.data?.items.length===0&&<Notice>ليست لديك صلاحية قراءة مجموعات الشروح.</Notice>}
  {groups.data&&groups.data.items.length>1&&<div className="explain-reader-choose">
   <label htmlFor="reader-group">مجموعة الشرح</label>
   <select id="reader-group" value={group?.slug??""} onChange={e=>setParams({group:e.target.value})}>
    {groups.data.items.map(g=><option key={g.id} value={g.slug}>{g.title}</option>)}
   </select>
  </div>}
  {topics.error&&<Notice tone="error">{errorMessage(topics.error)}</Notice>}
  {topics.isPending&&group&&<Notice>جارٍ تحميل قائمة العناوين…</Notice>}
  {topics.data&&<div className="explain-reader-list">
   <h2>{topics.data.group.title}</h2>
   {topics.data.topics.map((t,i)=><Link className="explain-reader-topic-link" key={t.id} to={"/explanations/topic/"+t.id}>
    <span className="topic-index-number">{arabic(i+1)}</span><span>{t.title}</span><span aria-hidden="true">‹</span>
   </Link>)}
   {topics.data.topics.length===0&&<p>لم تُسجل عناوين متاحة للقراءة بعد.</p>}
  </div>}
 </section>;
}

export function ExplanationsTopicReader() {
 const {topicId}=useParams();
 const {user}=useSession();
 const currentId=Number(topicId)||0;
 const [selected,setSelected]=useState<Asset|null>(null);
 const query=useQuery({queryKey:["explanations","topic",currentId,user?.id],
   queryFn:()=>api<TopicData>("/explanations/topics/"+currentId),enabled:currentId>0&&!!user});
 const data=query.data;
 const nodes=data?.nodes??[];
 const root=nodes.find(n=>n.id===currentId);
 const byParent=new Map<number,Node[]>();
 for(const node of nodes) {
  if(node.parentId===null)continue;
  const siblings=byParent.get(node.parentId)??[];
  siblings.push(node);byParent.set(node.parentId,siblings);
 }
 for(const siblings of byParent.values())siblings.sort((a,b)=>a.position-b.position||a.id-b.id);
 const renderFiles=(assets:Asset[]):ReactNode=>
  assets.length===0?null:<span className="explain-inline-assets"> {assets.map(file=>
    file.mimeType.startsWith("image/")?
    <button type="button" key={file.id} className="explain-inline-asset"
      onClick={()=>setSelected(file)} title={file.filename}>{file.displayName||file.filename}</button>:
    <a key={file.id} href={assetUrl(file.id)} target="_blank" rel="noreferrer"
      className="explain-inline-asset explain-inline-pdf" title={file.filename}>{file.displayName||file.filename}</a>
  )}</span>;
 const renderChildren=(parentId:number,depth=1):ReactNode=>
  (byParent.get(parentId)??[]).map((node,index)=>{
   const number=arabic(index+1);
   const heading=node.kind==="heading";
   return <div key={node.id} className={heading?"explain-print-heading":"explain-print-paragraph"}>
    {heading?
      <div className={depth>=2?"explain-subheading-two":"explain-subheading-one"} style={{color:node.color||undefined,fontSize:node.fontSize||undefined}}>
       {node.title}{node.body&&<p className="explain-heading-body">{node.body}</p>}{renderFiles(node.assets)}
      </div>:
      <div className="explain-print-line">
       <span className="explain-paragraph-number">{number}.</span>
       <div className="explain-print-copy" style={{color:node.color||undefined,fontSize:node.fontSize||undefined}}>
        {node.title&&<strong>{node.title}. </strong>}{node.body}
        {renderFiles(node.assets)}
        {node.evidence&&<p className="explain-evidence">وجه الاستدلال: {node.evidence}</p>}
       </div>
      </div>}
    {renderChildren(node.id,depth+1)}
   </div>;
  });
 const ordered=data?.topics??[];
 const currentIndex=ordered.findIndex(t=>t.id===currentId);
 const previous=currentIndex>0?ordered[currentIndex-1]:null;
 const next=currentIndex>=0&&currentIndex+1<ordered.length?ordered[currentIndex+1]:null;
 useEffect(()=>{setSelected(null);window.scrollTo({top:0,behavior:"instant"});},[currentId]);
 return <section className="explain-document-screen" dir="rtl">
  <div className="explain-document-toolbar">
   <Link className="button button-secondary" to={"/explanations/topics?group="+encodeURIComponent(data?.group.slug||"mustafa-cases")}>جميع الموضوعات</Link>
   <Button variant="secondary" onClick={()=>window.print()} disabled={!root}>طباعة الموضوع</Button>
   {root&&<Button variant="secondary" onClick={()=>void navigator.clipboard.writeText(window.location.href)}>نسخ رابط الموضوع</Button>}
   <span className="explain-toolbar-gap"/>
   {previous&&<Link className="button button-secondary" to={"/explanations/topic/"+previous.id}>السابق</Link>}
   {next&&<Link className="button button-secondary" to={"/explanations/topic/"+next.id}>التالي</Link>}
  </div>
  {query.isPending&&<Notice>جارٍ تحميل الموضوع…</Notice>}
  {query.error&&<Notice tone="error">{errorMessage(query.error)}</Notice>}
  {root&&data&&<article className="explain-print-paper">
   <div className="explain-print-kicker">{data.group.title}</div>
   <h1 style={{color:root.color||undefined,fontSize:root.fontSize||undefined}}>{root.title}</h1>
   {root.body&&<p className="explain-print-intro">{root.body}</p>}
   {renderFiles(root.assets)}
   <div className="explain-print-text">{renderChildren(root.id)}</div>
  </article>}
  <ImageDialog asset={selected} onClose={()=>setSelected(null)}/>
 </section>;
}

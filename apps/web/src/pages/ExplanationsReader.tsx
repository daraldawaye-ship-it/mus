import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
  assets.length===0?null:<span className="explain-inline-assets" aria-label="صور ومستندات الفقرة">{assets.map(file=>
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
       {node.title}
       {node.body&&<p className="explain-heading-body">{node.body}</p>}
       {node.evidence&&<p className="explain-evidence">وجه الاستدلال: {node.evidence}</p>}
       {renderFiles(node.assets)}
      </div>:
      <div className="explain-print-line">
       <span className="explain-paragraph-number">{number}.</span>
       <div className="explain-print-copy" style={{color:node.color||undefined,fontSize:node.fontSize||undefined}}>
        {node.title&&<strong>{node.title}. </strong>}{node.body}
        {node.evidence&&<p className="explain-evidence">وجه الاستدلال: {node.evidence}</p>}
        {renderFiles(node.assets)}
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
   {root.evidence&&<p className="explain-evidence">وجه الاستدلال: {root.evidence}</p>}
   {renderFiles(root.assets)}
   <div className="explain-print-text">{renderChildren(root.id)}</div>
  </article>}
  <ImageDialog asset={selected} onClose={()=>setSelected(null)}/>
 </section>;
}


type FlowNode = Node & {depth:number;ordinal:number;parentKind:string|null};
type FlowPage = {group:Group;total:number;offset:number;hasMore:boolean;nodes:FlowNode[]};
const letterMarks=["أ","ب","ج","د","هـ","و","ز","ح","ط","ي","ك","ل","م","ن","س","ع","ف","ص","ق","ر","ش","ت","ث","خ","ذ","ض","ظ","غ"];
const markerFor=(node:FlowNode)=>node.parentKind==="paragraph"&&node.depth>=2
 ? (letterMarks[node.ordinal-1]??arabic(node.ordinal))
 : arabic(node.ordinal);

export function ExplanationsContinuousReader() {
 const {user}=useSession();
 const [params,setParams]=useSearchParams();
 const requested=params.get("group")||"mustafa-cases";
 const groups=useQuery({queryKey:["explanations","groups",user?.id],
  queryFn:()=>api<{items:Group[]}>("/explanations/groups"),enabled:!!user});
 const group=groups.data?.items.find(g=>g.slug===requested)??groups.data?.items[0];
 const groupId=group?.id??0;
 const pages=useInfiniteQuery({
  queryKey:["explanations","flow",user?.id,groupId],
  initialPageParam:0,
  queryFn:({pageParam,signal})=>api<FlowPage>(
   "/explanations/groups/"+groupId+"/document?offset="+pageParam,{signal}),
  getNextPageParam:last=>last.hasMore?last.offset+last.nodes.length:undefined,
  enabled:!!user&&groupId>0,
 });
 const [selected,setSelected]=useState<Asset|null>(null);
 const [printData,setPrintData]=useState<FlowPage|null>(null);
 const [printBusy,setPrintBusy]=useState(false);
 const [printError,setPrintError]=useState("");
 const loadingEnd=useRef<HTMLDivElement|null>(null);
 const printed=useRef(false);
 const currentCount=pages.data?.pages.reduce((n,p)=>n+p.nodes.length,0)??0;
 const more=pages.hasNextPage;
 const fetching=pages.isFetchingNextPage;
 const loadNext=pages.fetchNextPage;
 useEffect(()=>{
  const sentinel=loadingEnd.current;
  if(!sentinel||!more||fetching||!!printData)return;
  const observer=new IntersectionObserver(entries=>{
   if(entries.some(entry=>entry.isIntersecting))void loadNext();
  },{rootMargin:"550px 0px"});
  observer.observe(sentinel);
  return ()=>observer.disconnect();
 },[more,fetching,loadNext,printData,currentCount]);
 useEffect(()=>{
  if(!printData)return;
  const onAfter=()=>{setPrintData(null);printed.current=false;};
  window.addEventListener("afterprint",onAfter);
  const raf=requestAnimationFrame(()=>{
   requestAnimationFrame(()=>{
    if(!printed.current){printed.current=true;window.print();}
   });
  });
  return ()=>{cancelAnimationFrame(raf);window.removeEventListener("afterprint",onAfter);};
 },[printData]);
 useEffect(()=>{setPrintData(null);printed.current=false;setSelected(null);setPrintError("");},[groupId]);
 const printAll=async()=>{
  if(!groupId||printBusy)return;
  setPrintError("");setPrintBusy(true);
  try{
   const data=await api<FlowPage>("/explanations/groups/"+groupId+"/document?all=true");
   setPrintData(data);
  }catch(error){setPrintError(errorMessage(error));}
  finally{setPrintBusy(false);}
 };
 const display=printData?.nodes??pages.data?.pages.flatMap(p=>p.nodes)??[];
 const total=printData?.total??pages.data?.pages[0]?.total??0;
 const renderAttachments=(assets:Asset[])=>assets.length?<span className="explain-inline-assets" aria-label="صور ومستندات الفقرة">{assets.map(asset=>
  asset.mimeType.startsWith("image/")?
   <button key={asset.id} type="button" className="explain-inline-asset"
    onClick={()=>setSelected(asset)} title={asset.filename}>{asset.displayName||asset.filename}</button>:
   <a key={asset.id} className="explain-inline-asset explain-inline-pdf"
    href={assetUrl(asset.id)} target="_blank" rel="noreferrer" title={asset.filename}>
    {asset.displayName||asset.filename}</a>
 )}</span>:null;
 return <section className="explain-document-screen explain-flow-screen" dir="rtl">
  <div className="explain-flow-toolbar">
   <div className="explain-flow-bar">
    <strong>{group?.title||"مكتبة الشروح"}</strong>
    <span className="explain-flow-count">المعروض {currentCount} من {total} سجلًا</span>
    <span className="explain-toolbar-gap"/>
    {group?.canEdit&&<Link className="button button-secondary"
     to={"/explanations?group="+encodeURIComponent(group.slug)}>الإضافة والتعديل</Link>}
    {user?.owner&&<Link className="button button-secondary" to="/explanations/access">منح صلاحيات الصفحات</Link>}
    <Button variant="secondary" disabled={printBusy||!groupId||pages.isPending} onClick={()=>void printAll()}>
     {printBusy?"جارٍ تجهيز الملف…":"طباعة الملف كاملًا"}
    </Button>
   </div>
   {groups.data&&groups.data.items.length>1&&<div className="explain-reader-choose">
    <label htmlFor="flow-group">المجموعة</label>
    <select id="flow-group" value={group?.slug??""}
     onChange={event=>setParams({group:event.target.value})}>
     {groups.data.items.map(g=><option key={g.id} value={g.slug}>{g.title}</option>)}
    </select>
   </div>}
   {printData&&<Button variant="secondary" onClick={()=>window.print()}>
    إعادة فتح الطباعة
   </Button>}
  </div>
  {printError&&<Notice tone="error">{printError}</Notice>}
  {groups.error&&<Notice tone="error">{errorMessage(groups.error)}</Notice>}
  {pages.error&&<Notice tone="error">{errorMessage(pages.error)}</Notice>}
  {pages.isPending&&group&&<Notice>جارٍ تحميل الشروح…</Notice>}
  {groups.data?.items.length===0&&<Notice>ليس لديك صلاحية لقراءة مجموعات الشروح.</Notice>}
  {group&&display.length>0&&<article className="explain-flow-paper">
   <header className="explain-flow-header">
    <small>{group.title}</small><h1>{group.title}</h1>
   </header>
   <div className="explain-flow-content">
    {display.map(node=>{
     const topic=node.depth===0,subhead=node.kind==="heading";
     const alpha=node.parentKind==="paragraph"&&node.depth>=2;
     const style={color:node.color||undefined,fontSize:node.fontSize||undefined};
     return <div key={node.id} id={"explain-record-"+node.id}
      className={"explain-flow-record"+(topic?" explain-flow-topic":subhead?" explain-flow-subheading":" explain-flow-paragraph")+
        (alpha?" explain-flow-letter":"") }
      style={topic||subhead?undefined:{marginInlineStart:alpha?"1.5rem":node.depth>1?"0.8rem":undefined}}>
      {topic?<h2 style={style}>{markerFor(node)}. {node.title}</h2>:
       subhead?<h3 className={node.depth>=2?"explain-flow-subheading-two":"explain-flow-subheading-one"}
        style={style}>{node.title}</h3>:
       <div className="explain-flow-line">
        <span className="explain-flow-marker">{markerFor(node)}.</span>
        <div className="explain-flow-copy" style={style}>
         {node.title&&<strong>{node.title}. </strong>}{node.body}
         {node.evidence&&<div className="explain-evidence">وجه الاستدلال: {node.evidence}</div>}
         {renderAttachments(node.assets)}
        </div>
       </div>}
      {(topic||subhead)&&node.body&&<p className="explain-flow-heading-body">{node.body}</p>}
      {(topic||subhead)&&node.evidence&&<p className="explain-evidence">وجه الاستدلال: {node.evidence}</p>}
      {(topic||subhead)&&renderAttachments(node.assets)}
     </div>;
    })}
   </div>
  </article>}
  {group&&more&&!printData&&<div ref={loadingEnd} className="explain-flow-loading"
   aria-live="polite">{fetching?"جارٍ تحميل ٥٠ سجلًا إضافيًا…":"يستكمل العرض تلقائيًا عند التمرير…"}</div>}
  {pages.isFetchingNextPage&&pages.isError&&<Button variant="secondary"
   onClick={()=>void pages.fetchNextPage()}>إعادة تحميل السجلات</Button>}
  <ImageDialog asset={selected} onClose={()=>setSelected(null)}/>
 </section>;
}

import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  productForms, compositionForms, itemFieldPatchSchema, itemCompositionPatchSchema,
  type CompanyContext, type ProductForm, type ItemComposition,
  compositionAssignmentSchema, type CompositionAssignmentInput,
} from "../../../../packages/contracts/src/index.ts";
import { Pencil } from "lucide-react";
import "../doctor-inline-cells.css";
import { api, ApiFailure, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";
import { rememberRecentEntity } from "../recent-entities";

const InvoiceItemEditor=lazy(()=>import("./ItemsPages").then(m=>({default:m.InvoiceItemEditor})));
const CompositionEditorSheet=lazy(()=>import("./ItemCompositionsPage").then(m=>({default:m.CompositionEditorSheet})));
type SortKey="itemName"|"itemForm"|"compositionName"|"compositionForm"|"saleTimesYear"|"availableAlternatives"|"availableUnit1";
const sortLabels:Record<SortKey,string>={
  itemName:"اسم الصنف",itemForm:"شكل الصنف",
  compositionName:"اسم التركيب",compositionForm:"شكل التركيب",
  saleTimesYear:"مرات البيع",
  availableAlternatives:"عدد البدائل",
  availableUnit1:"الكمية المتوفرة",
};


type Status="needs-review"|"different"|"unclassified"|"all";
interface Difference {
  itemId:number;itemName:string;itemForm:ProductForm;itemActive:boolean;
  compositionId:number;compositionName:string;compositionForm:ProductForm;compositionActive:boolean;
  // Totals for the entire composition, from the same independent projections
  // used by the composition card; null means unavailable for this user.
  saleTimesYear:string|null;
  availableAlternatives:number|null;
  availableUnit1:string|null;
}
interface Results {items:Difference[];total:number;page:number;pageSize:number}
const statsNumber=(value:string|number|null,digits=0)=>
  value==null?"—":Number(value).toLocaleString("en-US",{maximumFractionDigits:digits});


type InlineField="itemName"|"itemForm"|"compositionName"|"compositionForm";
const itemFormChoices=productForms.filter(form =>
  form!=="اقراص/كبسول" && form!=="مرهم/كريم/جل");

/** The report edits the master field, using the same click/blur/Enter flow as doctors. */
function DifferenceInlineCell({row,field,companyId,canEdit,locks,onSaved,onFailure}:{
  row:Difference;field:InlineField;companyId:number;canEdit:boolean;
  locks:Set<string>;
  onSaved:(value:string)=>void;onFailure:(message:string)=>void;
}){
  const isComposition=field==="compositionName"||field==="compositionForm";
  const isForm=field==="itemForm"||field==="compositionForm";
  const id=isComposition?row.compositionId:row.itemId;
  const scope=useScopeGuard(`company:${companyId}:form-inline:${id}:${field}`);
  const original=row[field];
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState(String(original));
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const cancelled=useRef(false);
  const baseline=useRef(String(original));
  useEffect(()=>{if(!editing)setDraft(String(original));},[original,editing]);
  function cancel(){
    cancelled.current=true;
    setDraft(String(original));
    setEditing(false);
  }
  async function save(valueText=draft){
    if(pending.current||cancelled.current)return;
    const value=valueText.trim();
    if(value===baseline.current){setEditing(false);return;}
    if(!value){onFailure(`الحقل «${sortLabels[field]}» مطلوب.`);return;}
    const lock=`${isComposition?"composition":"item"}:${id}`;
    if(locks.has(lock)){
      onFailure("جارٍ حفظ حقل آخر في الكرت نفسه؛ أعد الحفظ بعد اكتماله.");
      return;
    }
    pending.current=true;locks.add(lock);setBusy(true);
    try{
      if(isComposition){
        // Preserve all other composition attributes and detect a stale displayed field.
        const {composition:c}=await api<{composition:ItemComposition}>(
          `/companies/${companyId}/item-compositions/${id}`,{signal:scope.signal});
        const current=field==="compositionName"?c.arabicName:c.productForm;
        if(current!==baseline.current)
          throw new Error("تغيرت قيمة الحقل بواسطة تعديل آخر؛ حدّث القائمة ثم أعد المحاولة.");
        const body=itemCompositionPatchSchema.parse({
          arabicName:field==="compositionName"?value:c.arabicName,
          englishName:field==="compositionName"?value:c.englishName,
          productForm:field==="compositionForm"?value:c.productForm,
          revision:c.revision,description:c.description,saleNotes:c.saleNotes,
          priceSplitThreshold:c.priceSplitThreshold,originalItemId:c.originalItemId,
          active:c.active,identicalAlternative:c.identicalAlternative,
          nonInterchangeable:c.nonInterchangeable,
        });
        await api(`/companies/${companyId}/item-compositions/${id}`,{
          method:"PATCH",body,signal:scope.signal});
      }else{
        const key=field==="itemName"?"name":"productForm";
        const body=itemFieldPatchSchema.parse({
          changes:{[key]:value},expected:{[key]:baseline.current},
        });
        await api(`/companies/${companyId}/items/${id}`,{
          method:"PATCH",body,signal:scope.signal});
      }
      if(scope.isCurrent()){
        setEditing(false);
        onSaved(value);
      }
    }catch(error){
      if(scope.isCurrent())onFailure(`لم يحفظ ${sortLabels[field]}: ${errorMessage(error)}`);
    }finally{
      pending.current=false;locks.delete(lock);
      if(scope.isCurrent())setBusy(false);
    }
  }
  if(!canEdit)return <>{original}</>;
  if(!editing)return <button type="button" className="doctor-inline-trigger"
    title={`تعديل ${sortLabels[field]} مباشرة`}
    aria-label={`تعديل ${sortLabels[field]} — ${isComposition?row.compositionName:row.itemName}`}
    onClick={()=>{
      baseline.current=String(original);cancelled.current=false;
      setDraft(String(original));setEditing(true);
    }}>
    <span className="doctor-inline-value">{original}</span>
    <Pencil size={13} aria-hidden="true" className="doctor-inline-pencil"/>
  </button>;
  if(isForm)return <select autoFocus className="doctor-inline-editor"
    aria-label={sortLabels[field]} value={draft} disabled={busy}
    onChange={event=>{setDraft(event.target.value);void save(event.target.value);}}
    onBlur={()=>{void save();}}
    onKeyDown={event=>{
      if(event.key==="Escape"){event.preventDefault();cancel();}
      else if(event.key==="Enter"){event.preventDefault();void save();}
    }}>
    {(isComposition?compositionForms:itemFormChoices).map(form=>
      <option key={form} value={form}>{form}</option>)}
  </select>;
  return <input autoFocus className="doctor-inline-editor"
    aria-label={sortLabels[field]} value={draft} disabled={busy}
    maxLength={isComposition?240:120} dir={isComposition?"ltr":"rtl"}
    onChange={event=>setDraft(event.target.value)}
    onBlur={()=>{void save();}}
    onKeyDown={event=>{
      if(event.key==="Escape"){event.preventDefault();cancel();}
      else if(event.key==="Enter"){event.preventDefault();void save();}
    }}/>;
}

export function ItemFormDifferencesPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const {user}=useSession();
  const queryClient=useQueryClient();
  const [params,setParams]=useSearchParams();
  const [opened,setOpened]=useState<{type:"item"|"composition";id:number}|null>(null);
  const [itemSaving,setItemSaving]=useState(false);
  const [inlineError,setInlineError]=useState("");
  const inlineLocks=useRef(new Set<string>());
  const canEdit=context.general||context.permissions.includes("items.manage");
  const [selected,setSelected]=useState<Map<number,Difference>>(()=>new Map());
  const [bulkName,setBulkName]=useState("");
  const [bulkForm,setBulkForm]=useState<ProductForm|"">("");
  const [bulkTarget,setBulkTarget]=useState<ItemComposition|null>(null);
  const [bulkFocused,setBulkFocused]=useState(false);
  const [bulkBusy,setBulkBusy]=useState(false);
  const [bulkUnknown,setBulkUnknown]=useState(false);
  const [bulkMessage,setBulkMessage]=useState("");
  const bulkPending=useRef(false);
  const bulkRequest=useRef<CompositionAssignmentInput|null>(null);
  const bulkGuard=useScopeGuard(`company:${companyId}:composition-assignment`);
  const suggestions=useQuery({
    queryKey:["composition-assignment-options",user?.id,companyId,bulkName],
    queryFn:({signal})=>api<{items:ItemComposition[]}>(
      `/companies/${companyId}/item-compositions?`+new URLSearchParams({
        q:bulkName.trim(),active:"true",pageSize:"20",sort:"arabicName:asc",
      }),{signal}),
    enabled:!!user&&canEdit&&bulkFocused&&!bulkBusy&&!bulkUnknown,
    staleTime:15000,
  });
  const exactTargets=(suggestions.data?.items??[]).filter(composition=>
    composition.arabicName.trim().toLowerCase()===bulkName.trim().toLowerCase());
  const resolvedTarget=bulkTarget??(exactTargets.length===1?exactTargets[0]:null);
  const chosenForm=resolvedTarget?.productForm??bulkForm;
  useEffect(()=>{
    setSelected(new Map());setBulkName("");setBulkForm("");setBulkTarget(null);
    setBulkFocused(false);setBulkBusy(false);setBulkUnknown(false);setBulkMessage("");
    bulkRequest.current=null;bulkPending.current=false;
  },[companyId]);
  function toggle(row:Difference,checked:boolean){
    if(bulkBusy||bulkUnknown)return;
    setSelected(previous=>{
      const next=new Map(previous);
      if(checked){
        if(next.size>=500&&!next.has(row.itemId)){
          setInlineError("الحد الأقصى 500 صنف في عملية الحفظ الواحدة.");return previous;
        }
        next.set(row.itemId,row);
      }else next.delete(row.itemId);
      return next;
    });
  }
  async function saveAssignment(event:FormEvent){
    event.preventDefault();
    if(!canEdit||bulkPending.current)return;
    if(!bulkUnknown){
      const parsed=compositionAssignmentSchema.safeParse({
        name:bulkName,productForm:chosenForm,targetCompositionId:resolvedTarget?.id??null,
        items:[...selected.values()].sort((a,b)=>a.itemId-b.itemId).map(row=>({
          id:row.itemId,expectedCompositionId:row.compositionId,expectedProductForm:row.itemForm,
        })),idempotencyKey:crypto.randomUUID(),
      });
      if(!parsed.success){setInlineError(parsed.error.issues[0]?.message??"اختر الأصناف واسم التركيب وشكله.");return;}
      bulkRequest.current=parsed.data;
    }
    if(!bulkRequest.current)return;
    bulkPending.current=true;setBulkBusy(true);setInlineError("");setBulkMessage("");
    try{
      const response=await api<{composition:ItemComposition;itemIds:number[];updatedCount:number;created:boolean}>(
        `/companies/${companyId}/item-compositions/assign-selected`,{
          method:"POST",body:bulkRequest.current,signal:bulkGuard.signal,
        });
      if(!bulkGuard.isCurrent())return;
      setBulkUnknown(false);bulkRequest.current=null;setSelected(new Map());
      setBulkTarget(response.composition);setBulkName(response.composition.arabicName);
      setBulkForm(response.composition.productForm);
      setBulkMessage(`تم ${response.created?"إنشاء":"استخدام"} التركيب «${response.composition.arabicName}»؛ حُفظ ارتباط وشكل ${response.itemIds.length} صنفًا.`);
      void queryClient.invalidateQueries({predicate:({queryKey:key})=>
        key[1]===user?.id && (
          (key[0]==="item-form-differences"&&key[2]===companyId) ||
          (key[0]==="list"&&String(key[2]).startsWith(`company:${companyId}:`)) ||
          (["items","commerce","master","composition-sheet","composition-assignment-options","company"].includes(String(key[0]))&&key[2]===companyId)
        )});
    }catch(error){
      if(!bulkGuard.isCurrent())return;
      const uncertain=!(error instanceof ApiFailure)||error.status>=500;
      setBulkUnknown(uncertain);
      if(!uncertain)bulkRequest.current=null;
      setInlineError(errorMessage(error)+(uncertain?" — أعد تأكيد الطلب نفسه للتحقق من الحفظ دون تكراره.":""));
    }finally{
      if(bulkGuard.isCurrent()){bulkPending.current=false;setBulkBusy(false);}
    }
  }

  const q=params.get("q")??"";
  const [search,setSearch]=useState(q);
  const rawStatus=params.get("status");
  const status:Status=rawStatus==="different"||rawStatus==="unclassified"||
    rawStatus==="all"?rawStatus:"needs-review";
  const page=Math.max(1,Number(params.get("page")||1)||1);
  const rawSort=params.get("sort");
  const sort:SortKey|null=rawSort&&Object.prototype.hasOwnProperty.call(sortLabels,rawSort)
    ? rawSort as SortKey:null;
  const direction=params.get("direction")==="desc"?"desc":"asc";
  function orderBy(key:SortKey){
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      const same=sort===key;
      next.set("sort",key);
      const numeric=key==="saleTimesYear"||key==="availableAlternatives"||key==="availableUnit1";
      next.set("direction",same?(direction==="asc"?"desc":"asc"):(numeric?"desc":"asc"));
      next.delete("page");
      return next;
    });
  }
  function header(key:SortKey){
    const active=sort===key;
    return <th scope="col" aria-sort={!active?"none":direction==="asc"?"ascending":"descending"}>
      <button type="button" className="form-differences-sort"
        onClick={()=>orderBy(key)}
        aria-label={`ترتيب حسب ${sortLabels[key]} ${active&&direction==="asc"?"تنازليًا":"تصاعديًا"}`}>
        {sortLabels[key]} <span aria-hidden="true">{active?(direction==="asc"?"▲":"▼"):"↕"}</span>
      </button>
    </th>;
  }
  const [pageSize] = useState(50);
  useEffect(()=>setSearch(q),[q,companyId]);
  useEffect(()=>{setOpened(null);setItemSaving(false);setInlineError("");},[companyId]);
  const update=(key:string,value:string)=>{
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      if(value)next.set(key,value);else next.delete(key);
      next.delete("page");
      return next;
    });
  };
  const result=useQuery({
    queryKey:["item-form-differences",user?.id,companyId,status,q,sort,direction,page,pageSize],
    queryFn:({signal})=>api<Results>(
      `/companies/${companyId}/item-form-differences?`+
      new URLSearchParams({
        status,q,page:String(page),pageSize:String(pageSize),
        ...(sort?{sort,direction}:{}),
      }),
      {signal},
    ),
    enabled:!!user,
    staleTime:15000,
    placeholderData:previous=>previous,
  });
  const rows=result.data?.items??[];
  const close=()=>setOpened(null);
  const refresh=()=>{
    void queryClient.invalidateQueries({queryKey:["item-form-differences",user?.id,companyId]});
    close();
  };
  const inline=(row:Difference,field:InlineField)=><DifferenceInlineCell
    key={`${companyId}:${row.itemId}:${field}`} row={row} field={field}
    companyId={companyId} canEdit={canEdit&&!bulkBusy&&!bulkUnknown} locks={inlineLocks.current}
    onFailure={setInlineError} onSaved={value=>{
      setInlineError("");
      const composition=field==="compositionName"||field==="compositionForm";
      queryClient.setQueriesData<Results>(
        {queryKey:["item-form-differences",user?.id,companyId]},
        previous=>previous?{...previous,items:previous.items.map(item=>
          (composition?item.compositionId===row.compositionId:item.itemId===row.itemId)
            ? {...item,[field]:value}:item)}:previous);
      void queryClient.invalidateQueries({predicate:({queryKey:key})=>
        key[1]===user?.id && (
          (key[0]==="item-form-differences" && key[2]===companyId) ||
          (key[0]==="list" && String(key[2]).startsWith(`company:${companyId}:`)) ||
          (["items","commerce","master","composition-sheet"].includes(String(key[0])) &&
            key[2]===companyId)
        )});
    }}/>;
  return <>
    <PageHeader title="متابعة اختلاف شكل الصنف والتركيب"
      description="اضغط على اسم الصنف أو التركيب أو الشكل لتعديله مباشرة. تحفظ الأسماء عند الخروج أو Enter، والأشكال عند الاختيار؛ Esc للإلغاء."/>
    <Card title="الفحص والمقارنة">
      <div className="table-filters">
        <form onSubmit={event=>{event.preventDefault();update("q",search.trim());}}>
          <Field label="بحث بالاسم أو شكل الصنف أو شكل التركيب" value={search}
            placeholder="اسم الصنف أو التركيب أو شكل أحدهما"
            onChange={event=>setSearch(event.target.value)} />
          <Button type="submit" variant="secondary">بحث</Button>
        </form>
        <Select label="حالة المطابقة" value={status}
          onChange={event=>update("status",event.target.value)}>
          <option value="needs-review">تحتاج مراجعة (اختلاف أو عام)</option>
          <option value="different">اختلافات مؤكدة في الشكل</option>
          <option value="unclassified">أحدهما غير مصنف (عام)</option>
          <option value="all">كل الأصناف المرتبطة بتراكيب</option>
        </Select>
      </div>

      {canEdit&&<form className="table-filters" aria-label="تركيب الأصناف المختارة"
        onSubmit={event=>void saveAssignment(event)}>
        <div className="field" style={{position:"relative",minWidth:260,flex:"1 1 300px"}}>
          <label htmlFor="bulk-composition-name">اسم التركيب: ابحث عن موجود أو اكتب جديدًا</label>
          <input id="bulk-composition-name" role="combobox" aria-autocomplete="list"
            aria-expanded={bulkFocused} aria-controls={bulkFocused?"bulk-composition-options":undefined}
            autoComplete="off" value={bulkName} maxLength={240}
            disabled={bulkBusy||bulkUnknown}
            onFocus={()=>setBulkFocused(true)} onBlur={()=>setBulkFocused(false)}
            onChange={event=>{setBulkName(event.target.value);setBulkTarget(null);setBulkFocused(true);}}
            onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setBulkFocused(false);}}}/>
          {bulkFocused&&<div id="bulk-composition-options" role="listbox" aria-label="تراكيب موجودة"
            style={{position:"absolute",top:"100%",insetInline:0,zIndex:30,maxHeight:280,
              overflowY:"auto",background:"var(--surface, #1b2937)",border:"1px solid #74a9e3",borderRadius:5}}>
            {suggestions.isFetching&&<small>جارٍ البحث…</small>}
            {suggestions.error&&<Notice tone="error">{errorMessage(suggestions.error)}</Notice>}
            {(suggestions.data?.items??[]).map(composition=>
              <button type="button" role="option" key={composition.id}
                className="doctor-inline-trigger" aria-selected={bulkTarget?.id===composition.id}
                onPointerDown={event=>event.preventDefault()}
                onClick={()=>{
                  setBulkTarget(composition);setBulkName(composition.arabicName);
                  setBulkForm(composition.productForm);setBulkFocused(false);
                }}>{composition.arabicName} — {composition.productForm}</button>)}
            {!suggestions.isFetching&&!suggestions.error&&!suggestions.data?.items.length&&
              <small>لا توجد نتائج؛ يمكنك كتابة اسم جديد واختيار شكله ثم الحفظ.</small>}
          </div>}
        </div>
        <Select label="شكل التركيب" value={chosenForm} required
          disabled={bulkBusy||bulkUnknown||!!resolvedTarget}
          onChange={event=>setBulkForm(event.target.value as ProductForm|"")}>
          <option value="">اختر الشكل الصيدلاني</option>
          {compositionForms.map(form=><option key={form} value={form}>{form}</option>)}
        </Select>
        <Button type="submit" disabled={bulkBusy||(!bulkUnknown&&(!selected.size||!bulkName.trim()||!chosenForm))}>
          {bulkBusy?"جارٍ الحفظ…":bulkUnknown?"إعادة تأكيد الطلب نفسه":"حفظ"}
        </Button>
        <span>المختار: {selected.size}</span>
        <Button type="button" variant="secondary" disabled={bulkBusy||bulkUnknown||!selected.size}
          onClick={()=>setSelected(new Map())}>إلغاء الاختيار</Button>
        <small>{resolvedTarget?"سيُستخدم الكرت الموجود وشكله المحفوظ.":"اختيار نتيجة غير إلزامي؛ الاسم الجديد ينشئ كرتًا."}
          {" "}يتغير شكل الأصناف إلى شكل التركيب؛ أقراص/كبسول ← أقراص، ومرهم/كريم/جل ← مرهم.</small>
      </form>}
      {bulkMessage&&<Notice tone="success">{bulkMessage}</Notice>}
      <p className="muted">عدد النتائج: {result.data?.total??0}. التصنيف الآلي مبدئي؛ قد تختلف أشكال المستحضرات المرتبطة بالتركيب بشكل صحيح. الإحصائيات مجموع التركيب بأكمله من الجداول المنفصلة، وتظهر «—» عند عدم توفر صلاحية الاطلاع.</p>
      {inlineError&&<Notice tone="error">{inlineError}</Notice>}
      {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      <div className="table-scroll" role="region" tabIndex={0} aria-label="مراجعة اختلاف الشكل">
        <table className="data-table form-differences-table">
          <colgroup>
            <col style={{width:"4%"}} />
            <col style={{width:"18%"}} />
            <col style={{width:"10%"}} />
            <col style={{width:"22%"}} />
            <col style={{width:"9%"}} />
            <col style={{width:"7%"}} />
            <col style={{width:"7%"}} />
            <col style={{width:"9%"}} />
            <col style={{width:"14%"}} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <label>اختيار <input type="checkbox" aria-label="اختيار جميع أصناف الصفحة"
                  disabled={!canEdit||bulkBusy||bulkUnknown||!rows.length}
                  checked={!!rows.length&&rows.every(row=>selected.has(row.itemId))}
                  onChange={event=>{
                    const checked=event.target.checked;
                    if(checked&&new Set([...selected.keys(),...rows.map(row=>row.itemId)]).size>500){
                      setInlineError("الحد الأقصى 500 صنف في عملية الحفظ الواحدة.");return;
                    }
                    setSelected(previous=>{
                      const next=new Map(previous);
                      for(const row of rows)if(checked)next.set(row.itemId,row);else next.delete(row.itemId);
                      return next;
                    });
                  }}/></label>
              </th>
              {header("itemName")}{header("itemForm")}
              {header("compositionName")}{header("compositionForm")}
              {header("saleTimesYear")}
              {header("availableAlternatives")}
              {header("availableUnit1")}
              <th>الإجراء</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row=>{
              return <tr key={row.itemId}>
                <td><input type="checkbox" aria-label={`اختيار ${row.itemName}`}
                  disabled={!canEdit||bulkBusy||bulkUnknown} checked={selected.has(row.itemId)}
                  onChange={event=>toggle(row,event.target.checked)}/></td>
                <td>{inline(row,"itemName")}{!row.itemActive?" (مؤرشف)":""}</td>
                <td>{inline(row,"itemForm")}</td>
                <td>{inline(row,"compositionName")}{!row.compositionActive?" (مؤرشف)":""}</td>
                <td>{inline(row,"compositionForm")}</td>
                <td dir="ltr"><bdi>{statsNumber(row.saleTimesYear,0)}</bdi></td>
                <td dir="ltr"><bdi>{statsNumber(row.availableAlternatives,0)}</bdi></td>
                <td dir="ltr"><bdi>{statsNumber(row.availableUnit1,3)}</bdi></td>
                <td>
                  <div className="form-differences-inline-actions">
                    <Button variant="secondary" size="compact"
                      onClick={()=>{
                        if (user) rememberRecentEntity(user.id, companyId, "item",
                          {id:row.itemId,name:row.itemName});
                        setOpened({type:"item",id:row.itemId});
                      }}>كرت الصنف</Button>
                    <Button variant="secondary" size="compact"
                      onClick={()=>setOpened({type:"composition",id:row.compositionId})}>كرت التركيب</Button>
                  </div>
                </td>
              </tr>;
            })}
            {!rows.length&&!result.isFetching&&<tr><td colSpan={9}>لا توجد أصناف مطابقة للتصفية المختارة.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={page===1||result.isFetching}
          onClick={()=>setParams(previous=>{const next=new URLSearchParams(previous);next.set("page",String(page-1));return next;})}>السابق</Button>
        <span>صفحة {page} من {Math.max(1,Math.ceil((result.data?.total??0)/pageSize))}</span>
        <Button variant="secondary" disabled={result.isFetching||page*pageSize>=(result.data?.total??0)}
          onClick={()=>setParams(previous=>{const next=new URLSearchParams(previous);next.set("page",String(page+1));return next;})}>التالي</Button>
      </div>
    </Card>
    <Dialog open={opened?.type==="item"} className="invoice-item-sheet"
      title="كرت الصنف" onClose={()=>{if(!itemSaving)close();}}>
      {opened?.type==="item"&&<Suspense fallback={<Notice>جارٍ تحميل كرت الصنف…</Notice>}>
        <InvoiceItemEditor key={`${companyId}:${opened.id}`} context={context}
          itemId={opened.id} onClose={()=>{if(!itemSaving)close();}}
          onSavingChange={setItemSaving}
          onSaved={refresh}/>
      </Suspense>}
    </Dialog>
    {opened?.type==="composition"&&<Suspense fallback={
      <Dialog open title="كرت التركيب" className="invoice-item-sheet" onClose={close}>
        <Notice>جارٍ تحميل كرت التركيب…</Notice>
      </Dialog>}>
      <CompositionEditorSheet key={`${companyId}:${opened.id}`}
        context={context} compositionId={opened.id}
        onClose={close} onSaved={refresh}/>
    </Suspense>}
  </>;
}

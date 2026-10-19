import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import {
  itemCompositionSchema,
  itemCompositionPatchSchema,
  type CompanyContext,
  type ItemComposition,
  type ItemCompositionInput,
  type Item,
  type ProductForm,
  productForms,
} from "../../../../packages/contracts/src/index";
import { api, ApiFailure, usePagedQuery, useScopeGuard, useSession } from "../api";
import { errorMessage, ServerLookup } from "../phase2";
import { itemsAccess } from "./ItemsPages";
import { CompositionImportDialog } from "../CompositionImportDialog";
import {
  Button, Card, DataTable, Dialog, Field, Notice,
  PageHeader, Select, ValueCell,
} from "../ui";

const LinkedItemEditor=lazy(()=>import("./ItemsPages").then(m=>({default:m.InvoiceItemEditor})));

export function ItemCompositionsPage({context}: {context: CompanyContext}) {
  const companyId=context.company.id;
  const canView=itemsAccess(context), canManage=itemsAccess(context,true);
  const guard=useScopeGuard(`company:${companyId}:compositions`);
  const [params,setParams]=useSearchParams();
  const active=params.get("active");
  const resource=`/companies/${companyId}/item-compositions${active ? `?active=${active}`: ""}`;
  const list=usePagedQuery<ItemComposition>(resource,`company:${companyId}:item-compositions`);
  const [editing,setEditing]=useState<ItemComposition|null|undefined>(undefined);
  const [importing,setImporting]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const editId=params.get("edit");
  useEffect(()=>{
    if(!editId || !/^[1-9][0-9]*$/.test(editId))return;
    let cancelled=false;
    void api<{composition:ItemComposition}>(
      `/companies/${companyId}/item-compositions/${editId}`,
    ).then(result=>{
      if(!cancelled){
        setEditing(result.composition);
        setParams(previous=>{
          const next=new URLSearchParams(previous);
          next.delete("edit");
          return next;
        },{replace:true});
      }
    }).catch(cause=>{
      if(!cancelled)setError(errorMessage(cause));
    });
    return ()=>{cancelled=true;};
  },[companyId,editId,setParams]);
  const columns=useMemo<ColumnDef<ItemComposition,unknown>[]>(()=>[
    {accessorKey:"arabicName",header:"الاسم العربي",size:210,
      cell:({row})=><ValueCell>{row.original.arabicName}</ValueCell>},
    {accessorKey:"productForm",header:"الشكل",size:100},
    {accessorKey:"englishName",header:"الاسم الإنجليزي",size:210,
      cell:({row})=><ValueCell>{row.original.englishName}</ValueCell>},
    {accessorKey:"description",header:"الشرح",size:260,
      cell:({row})=><ValueCell>{row.original.description||"—"}</ValueCell>},
    {accessorKey:"identicalAlternative",header:"البديل مطابق",size:120,
      cell:({row})=>row.original.identicalAlternative?"نعم":"لا"},
    {accessorKey:"nonInterchangeable",header:"غير قابل للتبديل",size:145,
      cell:({row})=>row.original.nonInterchangeable?"نعم":"لا"},
    {accessorKey:"active",header:"الحالة",size:100,
      cell:({row})=>row.original.active?"فعال":"مؤرشف"},
    {id:"actions",header:"الإجراء",enableSorting:false,size:110,
      cell:({row})=><Button variant="secondary" size="compact" disabled={busy}
        onClick={async ()=>{
          setBusy(true);setError("");
          try{
            const result=await api<{composition:ItemComposition}>(
              `/companies/${companyId}/item-compositions/${row.original.id}`,{signal:guard.signal});
            if(guard.isCurrent())setEditing(result.composition);
          }catch(e){if(guard.isCurrent())setError(errorMessage(e))}
          finally{if(guard.isCurrent())setBusy(false)}
        }}>{canManage?"تعديل":"عرض"}</Button>},
  ],[companyId,canManage,busy,guard]);
  if(!canView)return <Notice tone="warning">ليس لديك صلاحية عرض تراكيب الأصناف.</Notice>;
  return <>
    <PageHeader title="تراكيب الأصناف"
      description="كروت التراكيب التي يمكن ربطها بالأصناف. خيارات الاستبدال للتصنيف فقط."
      actions={canManage?<>
        <Button variant="secondary" onClick={()=>setImporting(true)}>استيراد التراكيب</Button>
        <Button onClick={()=>setEditing(null)}>تركيب جديد</Button>
      </>:undefined}/>
    {message&&<Notice tone="success">{message}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    <Card title="دليل التراكيب">
      <div className="table-filters">
        <Field label="بحث في التراكيب" type="search"
          placeholder="الاسم العربي أو الإنجليزي أو الشرح"
          value={list.query} onChange={e=>list.setQuery(e.target.value)}/>
        <Select label="حالة التركيب" value={active??""} onChange={e=>{
          setParams(previous=>{
            const next=new URLSearchParams(previous);
            e.target.value?next.set("active",e.target.value):next.delete("active");
            next.delete("page");return next;
          });
        }}>
          <option value="">كل الحالات</option>
          <option value="true">فعال</option>
          <option value="false">مؤرشف</option>
        </Select>
      </div>
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      <DataTable columns={columns} data={list.data?.items??[]}
        total={list.data?.total??0} page={list.page} pageSize={list.pageSize}
        sorting={list.sorting} onSortingChange={list.setSorting}
        onPageChange={list.setPage} onPageSizeChange={list.setPageSize}
        loading={list.loading} ariaLabel="جدول تراكيب الأصناف"/>
    </Card>
    {importing&&<CompositionImportDialog context={context}
      onClose={()=>setImporting(false)}
      onImported={()=>{void list.refetch();}}/>}
    {editing!==undefined&&<CompositionEditor
      key={editing?.id??"new"} context={context} companyId={companyId} canManage={canManage}
      record={editing} onClose={()=>setEditing(undefined)}
      onSaved={async(result)=>{
        setEditing(undefined);
        setMessage(`تم حفظ التركيب ${result.arabicName}.`);
        await list.refetch();
      }}/>}
  </>;
}
/** Create a composition from an item card without navigating away. */
export function CompositionCreatePopup({context,onClose,onSaved}:{
  context:CompanyContext;onClose:()=>void;onSaved:(composition:ItemComposition)=>void;
}){
  return <CompositionEditor context={context} companyId={context.company.id} record={null}
    canManage={itemsAccess(context,true)} onClose={onClose} onSaved={onSaved}/>;
}
/** Reuse the existing composition card as a bottom sheet in reports. */
export function CompositionEditorSheet({
  context,compositionId,onClose,onSaved,
}:{
  context:CompanyContext;compositionId:number;
  onClose:()=>void;onSaved:(composition:ItemComposition)=>void;
}){
  const {user}=useSession();
  const companyId=context.company.id;
  const canView=itemsAccess(context),canManage=itemsAccess(context,true);
  const query=useQuery({
    queryKey:["composition-sheet",user?.id,companyId,compositionId],
    queryFn:({signal})=>api<{composition:ItemComposition}>(
      `/companies/${companyId}/item-compositions/${compositionId}`,{signal}),
    enabled:!!user && canView,
    staleTime:0,
  });
  if(!canView)return <Dialog open title="كرت التركيب"
    className="invoice-item-sheet" onClose={onClose}>
    <Notice tone="warning">ليس لديك صلاحية عرض كرت التركيب.</Notice>
    <Button variant="secondary" onClick={onClose}>إغلاق</Button>
  </Dialog>;
  if(!query.data)return <Dialog open title="كرت التركيب"
    className="invoice-item-sheet" onClose={onClose}>
    {query.isPending?<Notice>جارٍ تحميل كرت التركيب…</Notice>
      :<Notice tone="error">{errorMessage(query.error)}</Notice>}
    <div className="form-actions">
      {query.error&&<Button variant="secondary" onClick={()=>void query.refetch()}>إعادة المحاولة</Button>}
      <Button variant="secondary" onClick={onClose}>إغلاق</Button>
    </div>
  </Dialog>;
  return <CompositionEditor key={`${companyId}:${compositionId}`}
    context={context} companyId={companyId} record={query.data.composition} canManage={canManage}
    sheet onClose={onClose} onSaved={onSaved}/>;
}

type LinkedGroupPage = {items:Item[];total:number;page:number;pageSize:number};
function LinkedCompositionGroup({
  title,companyId,compositionId,group,userId,originalItemId,onOpenItem,version,
}:{
  title:string;companyId:number;compositionId:number;group:"all"|"higher"|"lower";
  userId:number|undefined;originalItemId:number|null;onOpenItem:(id:number)=>void;
  version:number;
}){
  const [page,setPage]=useState(1);
  const linked=useQuery({
    queryKey:["composition-linked-items",userId,companyId,compositionId,group,page,version],
    queryFn:({signal})=>api<LinkedGroupPage>(
      `/companies/${companyId}/item-compositions/${compositionId}/linked-items?${new URLSearchParams({
        group,page:String(page),
      })}`,{signal}),
    enabled:!!userId,
  });
  return <div className="composition-price-group">
    <h5>{title} {linked.data?`(${linked.data.total})`:
      linked.error?"(تعذر التحميل)":"(جارٍ التحميل…)"}</h5>
    {linked.isPending&&<p>جارٍ تحميل الأصناف…</p>}
    {linked.error&&<Notice tone="error">
      {errorMessage(linked.error)}
      {" "}<Button type="button" variant="secondary" size="compact"
        onClick={()=>void linked.refetch()}>إعادة المحاولة</Button>
    </Notice>}
    <div className="table-scroll">
      <table className="data-table"><thead><tr>
        <th>رمز الصنف</th><th>اسم الصنف</th><th>سعر بيع 1</th>
        <th>شكل الصنف</th><th>الحالة</th><th>الكرت</th>
      </tr></thead><tbody>
        {(linked.data?.items??[]).map(item=><tr key={item.id}>
          <td>{item.code}</td>
          <td>{item.name} {originalItemId===item.id&&
            <strong className="composition-original-label">أورجنال</strong>}</td>
          <td>{Number(item.salePrice1).toLocaleString("en-US",{maximumFractionDigits:6})}</td>
          <td>{item.productForm}</td>
          <td>{item.active?"فعال":"مؤرشف"}</td>
          <td><Button type="button" variant="secondary" size="compact"
            onClick={()=>onOpenItem(item.id)}>كرت الصنف</Button></td>
        </tr>)}
        {linked.isSuccess&&!linked.data.items.length&&
          <tr><td colSpan={6}>لا توجد أصناف في هذه المجموعة.</td></tr>}
      </tbody></table>
    </div>
    {linked.data&&linked.data.total>20&&<div className="form-actions">
      <Button type="button" variant="secondary" disabled={page===1}
        onClick={()=>setPage(n=>n-1)}>السابق</Button>
      <span>صفحة {page} من {Math.max(1,Math.ceil(linked.data.total/20))}</span>
      <Button type="button" variant="secondary"
        disabled={page*20>=linked.data.total}
        onClick={()=>setPage(n=>n+1)}>التالي</Button>
    </div>}
  </div>;
}

function CompositionEditor({
  context,companyId,record,canManage,onClose,onSaved,sheet=false,
}:{
  context:CompanyContext;companyId:number;record:ItemComposition|null;canManage:boolean;
  onClose:()=>void;onSaved:(value:ItemComposition)=>void;
  sheet?:boolean;
}){
  const guard=useScopeGuard(`company:${companyId}:item-composition:${record?.id??"new"}`);
  const {user}=useSession();
  const [linkedItemId,setLinkedItemId]=useState<number|null>(null);
  const [linkedBusy,setLinkedBusy]=useState(false);
  const [linkedVersion,setLinkedVersion]=useState(0);
  const [selectedOriginalItem,setSelectedOriginalItem]=useState<Item|null>(null);
  const [form,setForm]=useState({
    arabicName:record?.arabicName??"",
    englishName:record?.englishName??"",
    description:record?.description??"",
    saleNotes:record?.saleNotes??"",
    productForm:record?.productForm??"عام" as ProductForm,
    priceSplitThreshold:record?.priceSplitThreshold??null,
    originalItemId:record?.originalItemId??null,
    active:record?.active??true,
    identicalAlternative:record?.identicalAlternative??false,
    nonInterchangeable:record?.nonInterchangeable??false,
  });
  const originalItemQuery=useQuery({
    queryKey:["composition-original-item",user?.id,companyId,form.originalItemId],
    queryFn:({signal})=>api<{item:Item}>(
      `/companies/${companyId}/items/${form.originalItemId}`,{signal}),
    enabled:!!user&&!!record&&!!form.originalItemId,
  });
  const originalItem=selectedOriginalItem?.id===form.originalItemId
    ? selectedOriginalItem : originalItemQuery.data?.item??null;
  const [revision,setRevision]=useState(record?.revision??0);
  const [dirty,setDirty]=useState(false);
  const [saving,setSaving]=useState(false);
  const [unknown,setUnknown]=useState(false);
  const [conflict,setConflict]=useState(false);
  const [confirmClose,setConfirmClose]=useState(false);
  const [error,setError]=useState("");
  const [key]=useState(()=>crypto.randomUUID());
  const submitted=useRef<ItemCompositionInput|null>(null);
  const disabled=!canManage||saving||unknown;
  function set<K extends keyof typeof form>(name:K,value:(typeof form)[K]) {
    setDirty(true);
    setForm(previous=>{
      const next={...previous,[name]:value};
      if(name==="identicalAlternative"&&value)next.nonInterchangeable=false;
      if(name==="nonInterchangeable"&&value)next.identicalAlternative=false;
      return next;
    });
  }
  async function reload(){
    if(!record||saving)return;
    setSaving(true);setError("");
    try{
      const response=await api<{composition:ItemComposition}>(
        `/companies/${companyId}/item-compositions/${record.id}`,{signal:guard.signal});
      if(!guard.isCurrent())return;
      const result=response.composition;
      setForm({
        arabicName:result.arabicName,englishName:result.englishName,
        description:result.description,saleNotes:result.saleNotes,
        productForm:result.productForm,active:result.active,
        priceSplitThreshold:result.priceSplitThreshold,originalItemId:result.originalItemId,
        identicalAlternative:result.identicalAlternative,
        nonInterchangeable:result.nonInterchangeable,
      });
      setSelectedOriginalItem(null);
      setRevision(result.revision);setDirty(false);setConflict(false);
    }catch(e){if(guard.isCurrent())setError(errorMessage(e))}
    finally{if(guard.isCurrent())setSaving(false)}
  }
  async function save(event:FormEvent){
    event.preventDefault();
    if(!canManage||saving)return;
    setError("");
    const result=record
      ? itemCompositionPatchSchema.safeParse({...form,revision})
      : itemCompositionSchema.safeParse(unknown?submitted.current:{...form,idempotencyKey:key});
    if(!result.success){setError(result.error.issues[0]?.message??"تحقق من الحقول");return}
    if(!record)submitted.current=result.data as ItemCompositionInput;
    setSaving(true);
    try{
      const saved=await api<{composition:ItemComposition}>(
        `/companies/${companyId}/item-compositions${record?`/${record.id}`:""}`,{
          method:record?"PATCH":"POST",body:result.data,signal:guard.signal,
        });
      if(!guard.isCurrent())return;
      setUnknown(false);setDirty(false);setConflict(false);
      onSaved(saved.composition);
    }catch(e){
      if(!guard.isCurrent())return;
      if(!record&&(!(e instanceof ApiFailure)||e.status>=500))setUnknown(true);
      if(record&&e instanceof ApiFailure&&e.status===409)setConflict(true);
      setError(errorMessage(e));
    }finally{if(guard.isCurrent())setSaving(false)}
  }
  return <>
    <Dialog open title={record?"كرت التركيب — تعديل":"كرت تركيب جديد"}
      className={sheet?"invoice-item-sheet":""}
      onClose={()=>dirty||unknown?setConfirmClose(true):onClose()}>
      <form className="form-grid" onSubmit={e=>void save(e)}>
        {error&&<Notice tone="error">{error}</Notice>}
        {unknown&&<Notice tone="warning">نتيجة الحفظ غير مؤكدة؛ أعد تأكيد الطلب نفسه لتجنب تكرار التركيب.</Notice>}
        {conflict&&<Notice tone="warning">عدّل مستخدم آخر هذا الكرت.
          <Button variant="secondary" onClick={()=>void reload()}>تحميل النسخة الحالية</Button></Notice>}
        <Field label="الاسم بالعربي" value={form.arabicName} required maxLength={240}
          disabled={disabled} onChange={e=>set("arabicName",e.target.value)}/>
        <Field label="الاسم بالإنجليزي" value={form.englishName} required maxLength={240}
          disabled={disabled} dir="ltr" onChange={e=>set("englishName",e.target.value)}/>
        <Select label="شكل التركيب" value={form.productForm}
          disabled={disabled} onChange={e=>set("productForm",e.target.value as ProductForm)}>
          {productForms.map(value=><option key={value} value={value}>{value}</option>)}
        </Select>
        <Field label="الفارق بالسعر — سعر بيع الوحدة الأولى" type="number"
          min="0" step="0.000001" inputMode="decimal"
          placeholder="اختياري — فارغ يعني مجموعة واحدة"
          value={form.priceSplitThreshold??""} disabled={disabled}
          onChange={e=>set("priceSplitThreshold",e.target.value.trim()===""?null:e.target.value)}/>
        <div className="field">
          {record&&<ServerLookup<Item>
            companyId={companyId}
            resource={`/companies/${companyId}/items?compositionId=${record.id}`}
            label="الصنف الأورجنال (اختياري)"
            value={originalItem}
            onChange={item=>{
              setSelectedOriginalItem(item);
              set("originalItemId",item?.id??null);
            }}
            display={item=>`${item.code} — ${item.name}`}
            disabled={disabled} pageSize={50} sort="name:asc"
            singleInput
          />}
          {!record&&<small className="muted">
            اختر الصنف الأورجنال بعد حفظ التركيب وربط الأصناف به.
          </small>}
          {record&&form.originalItemId!==null&&<Button type="button"
            variant="secondary" size="compact" disabled={disabled}
            onClick={()=>{setSelectedOriginalItem(null);set("originalItemId",null);}}>
            إلغاء تعيين الأورجنال
          </Button>}
        </div>
        <div className="field form-full">
          <label htmlFor="composition-description">الشرح</label>
          <textarea id="composition-description" value={form.description}
            maxLength={2000} rows={3} disabled={disabled}
            onChange={e=>set("description",e.target.value)}/>
        </div>
        <div className="field form-full">
          <label htmlFor="composition-sale-notes">ملاحظات عند البيع</label>
          <textarea id="composition-sale-notes" value={form.saleNotes}
            maxLength={1000} rows={2} disabled={disabled}
            onChange={e=>set("saleNotes",e.target.value)}/>
        </div>
        <label className="check-label"><input type="checkbox" disabled={disabled}
          checked={!form.active} onChange={e=>set("active",!e.target.checked)}/>مؤرشف</label>
        <label className="check-label"><input type="checkbox" disabled={disabled}
          checked={form.identicalAlternative} onChange={e=>set("identicalAlternative",e.target.checked)}/>
          البديل مطابق</label>
        <label className="check-label"><input type="checkbox" disabled={disabled}
          checked={form.nonInterchangeable} onChange={e=>set("nonInterchangeable",e.target.checked)}/>
          غير قابل للتبديل</label>
        {record&&<div className="form-full">
          <h4>الأصناف المرتبطة بهذا التركيب</h4>
          {record.priceSplitThreshold!==null&&
            form.priceSplitThreshold!==record.priceSplitThreshold&&
            <small className="muted">سيُعاد تقسيم الأصناف بحسب السعر الجديد بعد حفظ التركيب.</small>}
          {record.priceSplitThreshold===null?
            <LinkedCompositionGroup title="جميع الأصناف" companyId={companyId}
              compositionId={record.id} group="all" userId={user?.id}
              originalItemId={form.originalItemId} version={linkedVersion}
              onOpenItem={setLinkedItemId}/>
            :<>
              <LinkedCompositionGroup
                title={`سعر بيع الوحدة الأولى أكبر من ${record.priceSplitThreshold}`}
                companyId={companyId} compositionId={record.id} group="higher"
                userId={user?.id} originalItemId={form.originalItemId}
                version={linkedVersion} onOpenItem={setLinkedItemId}/>
              <LinkedCompositionGroup
                title={`سعر بيع الوحدة الأولى أقل من أو يساوي ${record.priceSplitThreshold}`}
                companyId={companyId} compositionId={record.id} group="lower"
                userId={user?.id} originalItemId={form.originalItemId}
                version={linkedVersion} onOpenItem={setLinkedItemId}/>
            </>}
        </div>}
        {record&&<p className="muted form-full">الإصدار {revision} — لا تُحذف الكروت؛ يمكن أرشفتها.</p>}
        <div className="form-actions form-full">
          {canManage&&<Button type="submit" disabled={saving}>
            {saving?"جارٍ الحفظ…":unknown?"إعادة تأكيد الحفظ":"حفظ التركيب"}</Button>}
          <Button variant="secondary" disabled={saving}
            onClick={()=>dirty||unknown?setConfirmClose(true):onClose()}>إغلاق</Button>
        </div>
      </form>
    </Dialog>
    {linkedItemId!==null&&<Dialog open className="invoice-item-sheet" title="كرت الصنف"
      onClose={()=>{if(!linkedBusy)setLinkedItemId(null);}}>
      <Suspense fallback={<Notice>جارٍ تحميل كرت الصنف…</Notice>}>
        <LinkedItemEditor context={context} itemId={linkedItemId}
          onSavingChange={setLinkedBusy}
          onClose={()=>setLinkedItemId(null)}
          onSaved={()=>{setLinkedItemId(null);setLinkedVersion(v=>v+1);}}/>
      </Suspense>
    </Dialog>}
    <Dialog open={confirmClose} title="إغلاق كرت التركيب"
      onClose={()=>setConfirmClose(false)}>
      <p>{unknown?"قد تكون نتيجة الإنشاء محفوظة؛ تحقق من القائمة أولًا.":"هناك تغييرات لم تُحفظ."}</p>
      <div className="form-actions">
        <Button variant="secondary" onClick={()=>setConfirmClose(false)}>العودة للكرت</Button>
        <Button variant="danger" onClick={onClose}>إغلاق دون حفظ</Button>
      </div>
    </Dialog>
  </>;
}

import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext, ProductForm } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";

const InvoiceItemEditor=lazy(()=>import("./ItemsPages").then(m=>({default:m.InvoiceItemEditor})));
const CompositionEditorSheet=lazy(()=>import("./ItemCompositionsPage").then(m=>({default:m.CompositionEditorSheet})));
type SortKey="itemName"|"itemForm"|"compositionName"|"compositionForm";
const sortLabels:Record<SortKey,string>={
  itemName:"اسم الصنف",itemForm:"شكل الصنف",
  compositionName:"اسم التركيب",compositionForm:"شكل التركيب",
};


type Status="needs-review"|"different"|"unclassified"|"all";
interface Difference {
  itemId:number;itemName:string;itemForm:ProductForm;itemActive:boolean;
  compositionId:number;compositionName:string;compositionForm:ProductForm;compositionActive:boolean;
}
interface Results {items:Difference[];total:number;page:number;pageSize:number}

export function ItemFormDifferencesPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const {user}=useSession();
  const queryClient=useQueryClient();
  const [params,setParams]=useSearchParams();
  const [opened,setOpened]=useState<{type:"item"|"composition";id:number}|null>(null);
  const [itemSaving,setItemSaving]=useState(false);
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
      next.set("direction",same&&direction==="asc"?"desc":"asc");
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
  useEffect(()=>{setOpened(null);setItemSaving(false);},[companyId]);
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
  return <>
    <PageHeader title="متابعة اختلاف شكل الصنف والتركيب"
      description="مراجعة التصنيف المبدئي للأصناف والتراكيب. لا يغيّر التقرير أي تصنيف تلقائيًا؛ راجع الكرتين لتصحيح الاختلاف."/>
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
      <p className="muted">عدد النتائج: {result.data?.total??0}. التصنيف الآلي مبدئي؛ قد تختلف أشكال المستحضرات المرتبطة بالتركيب بشكل صحيح.</p>
      {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      <div className="table-scroll" role="region" tabIndex={0} aria-label="مراجعة اختلاف الشكل">
        <table className="data-table">
          <thead>
            <tr>
              {header("itemName")}{header("itemForm")}
              {header("compositionName")}{header("compositionForm")}
              <th>المراجعة</th><th>الإجراء</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row=>{
              const uncertain=row.itemForm==="عام"||row.compositionForm==="عام";
              const different=row.itemForm!==row.compositionForm;
              return <tr key={row.itemId}>
                <td>{row.itemName}{!row.itemActive?" (مؤرشف)":""}</td>
                <td>{row.itemForm}</td>
                <td>{row.compositionName}{!row.compositionActive?" (مؤرشف)":""}</td>
                <td>{row.compositionForm}</td>
                <td>{uncertain?"غير مصنف":different?"مختلف":"متطابق"}</td>
                <td>
                  <div className="form-actions">
                    <Button variant="secondary" size="compact"
                      onClick={()=>setOpened({type:"item",id:row.itemId})}>كرت الصنف</Button>
                    <Button variant="secondary" size="compact"
                      onClick={()=>setOpened({type:"composition",id:row.compositionId})}>كرت التركيب</Button>
                  </div>
                </td>
              </tr>;
            })}
            {!rows.length&&!result.isFetching&&<tr><td colSpan={6}>لا توجد أصناف مطابقة للتصفية المختارة.</td></tr>}
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

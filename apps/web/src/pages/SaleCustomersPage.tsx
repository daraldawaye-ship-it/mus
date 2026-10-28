import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import {
  saleCustomerInputSchema, saleCustomerPatchSchema,
  type SaleCustomer, type CompanyContext,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, DataTable, Dialog, Field, Notice, PageHeader } from "../ui";

function CustomerCard({context,customer,onClose,onSaved}:{
  context:CompanyContext;customer:SaleCustomer|null;onClose:()=>void;onSaved:()=>void;
}){
  const companyId=context.company.id;
  const guard=useScopeGuard(`company:${companyId}:sale-customer:${customer?.id??"new"}`);
  const [number,setNumber]=useState(customer?.customerNumber??"");
  const [name,setName]=useState(customer?.name??"");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  async function save(event:FormEvent){
    event.preventDefault();
    if(saving)return;
    const fields={customerNumber:number,name};
    const parsed=customer
      ? saleCustomerPatchSchema.safeParse({...fields,revision:customer.revision})
      : saleCustomerInputSchema.safeParse(fields);
    if(!parsed.success){setError(parsed.error.issues[0]?.message??"تحقق من البيانات");return;}
    setSaving(true);setError("");
    try{
      await api(`/companies/${companyId}/sale-customers${customer?"/"+customer.id:""}`,{
        method:customer?"PATCH":"POST",body:parsed.data,signal:guard.signal,
      });
      if(guard.isCurrent())onSaved();
    }catch(error){if(guard.isCurrent())setError(errorMessage(error));}
    finally{if(guard.isCurrent())setSaving(false);}
  }
  return <Dialog open title={customer?"تعديل كرت العميل":"إضافة كرت عميل"}
    onClose={()=>{if(!saving)onClose();}}>
    <form className="form-stack" onSubmit={event=>void save(event)}>
      {error&&<Notice tone="error">{error}</Notice>}
      <Field label="رقم العميل" type="text" inputMode="numeric" maxLength={30}
        required autoFocus value={number} disabled={saving}
        onChange={event=>setNumber(event.target.value)}/>
      <Field label="اسم العميل" maxLength={240} required value={name} disabled={saving}
        onChange={event=>setName(event.target.value)}/>
      <div className="form-actions">
        <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ"}</Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>العودة</Button>
      </div>
    </form>
  </Dialog>;
}
export function SaleCustomersPage({context}:{context:CompanyContext}){
  const companyId=context.company.id;
  const canView=context.general||context.permissions.includes("commerce.view")||context.permissions.includes("commerce.manage");
  const canEdit=context.general||context.permissions.includes("commerce.manage");
  const [params,setParams]=useSearchParams();
  const list=usePagedQuery<SaleCustomer>(
    `/companies/${companyId}/sale-customers`,`company:${companyId}:sale-customers`,"id:desc",
  );
  const [editing,setEditing]=useState<SaleCustomer|"new"|null>(null);
  const [notice,setNotice]=useState("");
  const focusId=Number(params.get("focus"));
  const focus=Number.isSafeInteger(focusId)&&focusId>0?focusId:null;
  const focused=useQuery({
    queryKey:["sale-customer-focus",companyId,focus],
    enabled:canEdit&&focus!==null,
    queryFn:({signal})=>api<{customer:SaleCustomer}>(`/companies/${companyId}/sale-customers/${focus}`,{signal}),
  });
  useEffect(()=>{if(focused.data?.customer)setEditing(focused.data.customer);},
    [focused.data?.customer?.id,focused.data?.customer?.revision]);
  function close(){
    setEditing(null);
    if(focus!==null)setParams(prev=>{
      const next=new URLSearchParams(prev);next.delete("focus");return next;
    });
  }
  const columns:ColumnDef<SaleCustomer,unknown>[]=[
    {accessorKey:"customerNumber",header:"رقم العميل"},
    {accessorKey:"name",header:"اسم العميل"},
    ...(canEdit?[{id:"actions",header:"إجراء",enableSorting:false,
      cell:({row}:{row:{original:SaleCustomer}})=>
        <Button size="compact" variant="ghost" onClick={()=>setEditing(row.original)}>تعديل</Button>,
    } satisfies ColumnDef<SaleCustomer,unknown>]:[]),
  ];
  if(!canView)return <Notice tone="warning">ليس لديك صلاحية عرض كروت العملاء.</Notice>;
  return <>
    <PageHeader title="كرت العملاء" description="رقم العميل واسمه، مستقلان عن الحسابات المالية."
      actions={canEdit?<Button onClick={()=>setEditing("new")}>إضافة عميل</Button>:undefined}/>
    {notice&&<Notice tone="success">{notice}</Notice>}
    {focused.isError&&<Notice tone="error">{errorMessage(focused.error)}</Notice>}
    <Card>
      <div className="table-filters">
        <Field label="بحث برقم العميل أو اسمه" type="search" value={list.query}
          onChange={event=>list.setQuery(event.target.value)}
          placeholder="رقم العميل أو اسم العميل"/>
      </div>
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      <DataTable columns={columns} data={list.data?.items??[]} total={list.data?.total??0}
        page={list.page} pageSize={list.pageSize} onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize} sorting={list.sorting}
        onSortingChange={list.setSorting} loading={list.loading}/>
    </Card>
    {canEdit&&editing!==null&&<CustomerCard key={editing==="new"?"new":editing.id}
      context={context} customer={editing==="new"?null:editing}
      onClose={close} onSaved={()=>{close();setNotice("تم حفظ كرت العميل.");void list.refetch();}}/>}
  </>;
}

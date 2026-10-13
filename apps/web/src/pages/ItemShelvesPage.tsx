import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import {
  arabicShelfLetters,
  itemShelfPatchSchema,
  type CompanyContext,
  type ItemShelf,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import { itemsAccess } from "./ItemsPages";
import {
  Button, Card, DataTable, Dialog, Field, Notice,
  PageHeader, Select, ValueCell,
} from "../ui";

export function ItemShelvesPage({context}: {context:CompanyContext}) {
  const companyId=context.company.id;
  const canView=itemsAccess(context),canManage=itemsAccess(context,true);
  const guard=useScopeGuard(`company:${companyId}:item-shelves`);
  const [params,setParams]=useSearchParams();
  const filters=new URLSearchParams();
  for(const key of ["groupLetter","archived","vitrine"]){
    const value=params.get(key);
    if(value!==null&&value!=="")filters.set(key,value);
  }
  const list=usePagedQuery<ItemShelf>(
    `/companies/${companyId}/item-shelves${filters.size?"?"+filters.toString():""}`,
    `company:${companyId}:item-shelves`,
  );
  const [editing,setEditing]=useState<ItemShelf|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  function filter(name:string,value:string) {
    setParams(current=>{
      const next=new URLSearchParams(current);
      value?next.set(name,value):next.delete(name);
      next.delete("page");
      return next;
    });
  }
  const columns=useMemo<ColumnDef<ItemShelf,unknown>[]>(()=>[
    {accessorKey:"name",header:"الرف",size:145,
      cell:({row})=><ValueCell>{row.original.name}</ValueCell>},
    {accessorKey:"groupOrder",header:"المجموعة",size:110,
      cell:({row})=>row.original.groupLetter},
    {accessorKey:"slotNumber",header:"رقم الرف",size:105,
      cell:({row})=>row.original.slotNumber},
    {accessorKey:"vitrine",header:"بترينة",size:115,
      cell:({row})=>row.original.vitrine?"نعم":"لا"},
    {accessorKey:"archived",header:"الحالة",size:105,
      cell:({row})=>row.original.archived?"مؤرشف":"فعال"},
    {id:"actions",header:"إجراء",enableSorting:false,size:100,
      cell:({row})=><Button variant="secondary" size="compact" disabled={busy}
        onClick={async()=>{
          setBusy(true);setError("");
          try{
            const result=await api<{shelf:ItemShelf}>(
              `/companies/${companyId}/item-shelves/${row.original.id}`,
              {signal:guard.signal},
            );
            if(guard.isCurrent())setEditing(result.shelf);
          }catch(e){if(guard.isCurrent())setError(errorMessage(e))}
          finally{if(guard.isCurrent())setBusy(false)}
        }}>{canManage?"تعديل":"عرض"}</Button>},
  ],[companyId,canManage,busy,guard]);
  if(!canView)return <Notice tone="warning">ليس لديك صلاحية عرض كروت الرفوف.</Notice>;
  return <>
    <PageHeader title="كرت الرفوف"
      description="٢٨ مجموعة من الحروف العربية؛ ١٢ رفًا لكل مجموعة، من ا-1 حتى ي-12. تُعدّل حالة الرف وموقع البترينة دون تغيير رمزه."/>
    {message&&<Notice tone="success">{message}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    <Card title="دليل الرفوف">
      <div className="table-filters">
        <Field label="بحث عن رف" type="search" placeholder="مثال: ب-12"
          value={list.query} onChange={e=>list.setQuery(e.target.value)}/>
        <Select label="المجموعة" value={params.get("groupLetter")??""}
          onChange={e=>filter("groupLetter",e.target.value)}>
          <option value="">كل المجموعات</option>
          {arabicShelfLetters.map(letter=>
            <option key={letter} value={letter}>{letter}</option>)}
        </Select>
        <Select label="الحالة" value={params.get("archived")??""}
          onChange={e=>filter("archived",e.target.value)}>
          <option value="">الكل</option>
          <option value="false">فعال</option>
          <option value="true">مؤرشف</option>
        </Select>
        <Select label="بترينة" value={params.get("vitrine")??""}
          onChange={e=>filter("vitrine",e.target.value)}>
          <option value="">الكل</option>
          <option value="true">نعم</option>
          <option value="false">لا</option>
        </Select>
      </div>
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      <DataTable columns={columns} data={list.data?.items??[]}
        total={list.data?.total??0} page={list.page} pageSize={list.pageSize}
        sorting={list.sorting} onSortingChange={list.setSorting}
        onPageChange={list.setPage} onPageSizeChange={list.setPageSize}
        loading={list.loading} ariaLabel="جدول كروت الرفوف"/>
    </Card>
    {editing&&<ShelfEditor key={editing.id} companyId={companyId}
      record={editing} canManage={canManage} onClose={()=>setEditing(null)}
      onSaved={async value=>{
        setEditing(null);
        setMessage(`تم حفظ كرت الرف ${value.name}`);
        await list.refetch();
      }}/>}
  </>;
}

function ShelfEditor({
  companyId,record,canManage,onClose,onSaved,
}: {
  companyId:number;record:ItemShelf;canManage:boolean;
  onClose:()=>void;onSaved:(shelf:ItemShelf)=>void;
}){
  const guard=useScopeGuard(`company:${companyId}:shelf:${record.id}`);
  const [archived,setArchived]=useState(record.archived);
  const [vitrine,setVitrine]=useState(record.vitrine);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [changed,setChanged]=useState(false);
  const [conflict,setConflict]=useState(false);
  async function save(event:FormEvent){
    event.preventDefault();
    if(!canManage||saving)return;
    const parsed=itemShelfPatchSchema.safeParse({
      revision:record.revision,archived,vitrine,
    });
    if(!parsed.success){setError(parsed.error.issues[0]?.message??"خطأ في البيانات");return}
    setError("");setSaving(true);
    try{
      const response=await api<{shelf:ItemShelf}>(
        `/companies/${companyId}/item-shelves/${record.id}`,{
          method:"PATCH",body:parsed.data,signal:guard.signal,
        });
      if(guard.isCurrent())onSaved(response.shelf);
    }catch(e){
      if(guard.isCurrent()){
        setError(errorMessage(e));
        setConflict(true);
      }
    }finally{if(guard.isCurrent())setSaving(false)}
  }
  return <Dialog open title={`كرت الرف — ${record.name}`} onClose={()=>{if(!saving)onClose()}}>
    <form className="form-grid" onSubmit={e=>void save(e)}>
      {error&&<Notice tone="error">{error}</Notice>}
      {conflict&&<Notice tone="warning">إذا عدّل مستخدم آخر هذا الرف، أغلق الكرت وافتحه مجددًا لعرض آخر إصدار.</Notice>}
      <Field label="الرف" value={record.name} readOnly/>
      <Field label="المجموعة" value={record.groupLetter} readOnly/>
      <label className="check-label">
        <input type="checkbox" checked={archived} disabled={!canManage||saving}
          onChange={e=>{setArchived(e.target.checked);setChanged(true)}}/>
        مؤرشف
      </label>
      <label className="check-label">
        <input type="checkbox" checked={vitrine} disabled={!canManage||saving}
          onChange={e=>{setVitrine(e.target.checked);setChanged(true)}}/>
        بترينة
      </label>
      <p className="muted form-full">يمكن تعديل حالة الرف والبترينة، أما رمز الرف ومجموعته فثابتان. أرشفة الرف لا تمحو أسماء الرفوف من الأصناف السابقة.</p>
      <div className="form-actions form-full">
        {canManage&&<Button type="submit" disabled={saving||!changed}>
          {saving?"جارٍ الحفظ…":"حفظ الرف"}</Button>}
        <Button variant="secondary" disabled={saving} onClick={onClose}>إغلاق</Button>
      </div>
    </form>
  </Dialog>;
}

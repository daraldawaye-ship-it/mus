import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import {
  doctorKinds,doctorKindLabels,doctorInputSchema,doctorPatchSchema,
  type Doctor,type DoctorKind,type CompanyContext,
} from "../../../../packages/contracts/src/index";
import { api,usePagedQuery,useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import { Button,Card,DataTable,Dialog,Field,Notice,PageHeader,Select,ValueCell } from "../ui";

function DoctorCard({context,doctor,onClose,onSaved}: {
  context:CompanyContext;doctor:Doctor|null;onClose:()=>void;onSaved:()=>void;
}) {
  const companyId=context.company.id;
  const guard=useScopeGuard(`company:${companyId}:doctor:${doctor?.id??"new"}`);
  const [name,setName]=useState(doctor?.name??"");
  const [kind,setKind]=useState<DoctorKind|"">(doctor?.kind??(doctor?"":"doctor"));
  const [department,setDepartment]=useState(doctor?.department??"");
  const [phone,setPhone]=useState(doctor?.phone??"");
  const [searchKeys,setSearchKeys]=useState(doctor?.searchKeys??"");
  const [notes,setNotes]=useState(doctor?.notes??"");
  const [active,setActive]=useState(doctor?.active??true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const suggestions=useQuery({
    queryKey:["doctor-departments",companyId],
    queryFn:({signal})=>api<{items:string[]}>(`/companies/${companyId}/doctors/departments`,{signal}),
  });
  async function save(event:FormEvent) {
    event.preventDefault();
    if(saving)return;
    const schema = doctor ? doctorPatchSchema : doctorInputSchema;
    const parsed=schema.safeParse({name,kind:kind||null,department,phone,searchKeys,notes,active});
    if(!parsed.success){setError(parsed.error.issues[0]?.message??"تحقق من الحقول");return;}
    setSaving(true);setError("");
    try {
      await api(`/companies/${companyId}/doctors${doctor?"/"+doctor.id:""}`,{
        method:doctor?"PATCH":"POST",
        body:doctor?{...parsed.data,revision:doctor.revision}:parsed.data,
        signal:guard.signal,
      });
      if(guard.isCurrent())onSaved();
    }catch(err){if(guard.isCurrent())setError(errorMessage(err));}
    finally{if(guard.isCurrent())setSaving(false);}
  }
  return <Dialog open title={doctor?"تعديل كرت الطبيب أو الجهة":"إضافة كرت طبيب أو جهة"} onClose={()=>{
    if(!saving)onClose();
  }}>
    <form className="form-stack" onSubmit={event=>void save(event)}>
      {error&&<Notice tone="error">{error}</Notice>}
      <Field label="اسم الطبيب أو الجهة" value={name} autoFocus required maxLength={240}
        disabled={saving} onChange={event=>setName(event.target.value)}/>
      <Select label="الفئة" value={kind} disabled={saving}
        onChange={event=>setKind(event.target.value as DoctorKind|"")}>
        <option value="" disabled={!doctor}>بدون فئة — يحتاج مراجعة</option>
        {doctorKinds.map(type=><option key={type} value={type}>{doctorKindLabels[type]}</option>)}
      </Select>
      <Field label="الجهة / القسم" value={department} list="doctor-department-suggestions"
        maxLength={240} disabled={saving} autoComplete="off"
        onChange={event=>setDepartment(event.target.value)}
        placeholder="اكتب جهة جديدة أو اختر من الجهات المدخلة سابقًا"/>
      <datalist id="doctor-department-suggestions">
        {suggestions.data?.items.map(value=><option key={value} value={value}/>)}
      </datalist>
      <Field label="رقم الهاتف" type="tel" value={phone} dir="ltr" maxLength={60}
        disabled={saving} onChange={event=>setPhone(event.target.value)}/>
      <Field label="مفاتيح البحث" value={searchKeys} maxLength={500}
        disabled={saving} onChange={event=>setSearchKeys(event.target.value)}/>
      <div className="field floating-ready"><label htmlFor="doctor-notes">ملاحظات</label>
        <textarea id="doctor-notes" rows={3} maxLength={2000} value={notes}
          disabled={saving} onChange={event=>setNotes(event.target.value)}/>
      </div>
      <Select label="الحالة" value={active?"true":"false"} disabled={saving}
        onChange={event=>setActive(event.target.value==="true")}>
        <option value="true">فعّال</option><option value="false">مؤرشف</option>
      </Select>
      {doctor && <Link className="button button-secondary" to={`/companies/${companyId}/stock-movements?doctorId=${doctor.id}`}>
        عرض حركات الأصناف للطبيب أو الجهة
      </Link>}
      <div className="form-actions">
        <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ"}</Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>العودة</Button>
      </div>
    </form>
  </Dialog>;
}
export function DoctorsPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const mayView=context.general||context.permissions.includes("commerce.view")||context.permissions.includes("commerce.manage");
  const mayManage=context.general||context.permissions.includes("commerce.manage");
  const [params,setParams]=useSearchParams();
  const activeFilter=params.get("active")==="false"?"false":params.get("active")==="all"?"all":"true";
  const list=usePagedQuery<Doctor>(
    `/companies/${companyId}/doctors${activeFilter==="all"?"":"?active="+activeFilter}`,
    `company:${companyId}:doctors`,"name:asc",
  );
  const [editing,setEditing]=useState<Doctor|"new"|null>(null);
  const [notice,setNotice]=useState("");
  // Notifications open the existing card; saving the review closes it.
  const focusId = Number(params.get("focus"));
  const focus = Number.isSafeInteger(focusId) && focusId > 0 ? focusId : null;
  const focused = useQuery({
    queryKey:["doctor-notification-focus",companyId,focus],
    enabled:mayManage && focus!==null,
    queryFn:({signal})=>api<{doctor:Doctor}>(`/companies/${companyId}/doctors/${focus}`,{signal}),
  });
  useEffect(()=>{
    if(focused.data?.doctor)setEditing(focused.data.doctor);
  },[focused.data?.doctor?.id,focused.data?.doctor?.revision]);
  function closeCard(){
    setEditing(null);
    if(focus!==null)setParams(previous=>{
      const next=new URLSearchParams(previous);
      next.delete("focus");
      return next;
    });
  }
  const columns:ColumnDef<Doctor,unknown>[]=[
    {accessorKey:"name",header:"اسم الطبيب أو الجهة",cell:({row})=><ValueCell>{row.original.name}</ValueCell>},
    {accessorKey:"kind",header:"الفئة",cell:({row})=>row.original.kind ? doctorKindLabels[row.original.kind] : "بدون فئة — مراجعة"},
    {accessorKey:"department",header:"الجهة",cell:({row})=><ValueCell>{row.original.department||"—"}</ValueCell>},
    {accessorKey:"phone",header:"رقم الهاتف",enableSorting:false,cell:({row})=><ValueCell>{row.original.phone||"—"}</ValueCell>},
    {accessorKey:"searchKeys",header:"مفاتيح البحث",enableSorting:false,cell:({row})=><ValueCell>{row.original.searchKeys||"—"}</ValueCell>},
    {accessorKey:"notes",header:"ملاحظات",enableSorting:false,cell:({row})=><ValueCell>{row.original.notes||"—"}</ValueCell>},
    {accessorKey:"active",header:"الحالة",cell:({row})=>row.original.active?"فعّال":"مؤرشف"},
    ...(mayManage?[{id:"actions",header:"الإجراء",enableSorting:false,
      cell:({row}:{row:{original:Doctor}})=><Button variant="ghost" size="compact"
        onClick={()=>setEditing(row.original)}>تعديل</Button>} satisfies ColumnDef<Doctor,unknown>]:[]),
  ];
  if(!mayView)return <Notice tone="warning">ليس لديك صلاحية عرض الأطباء والجهات.</Notice>;
  return <>
    <PageHeader title="كرت الأطباء والجهات" description="الأطباء والممرضون والجهات، دون إنشاء حساب محاسبي."
      actions={mayManage?<Button onClick={()=>setEditing("new")}>إضافة كرت</Button>:undefined}/>
    {notice&&<Notice tone="success">{notice}</Notice>}
    {focus!==null && !mayManage && <Notice tone="warning">فتح هذا الكرت للتعديل يحتاج صلاحية إدارة الأطباء والجهات.</Notice>}
    {focused.isError && <Notice tone="error">{errorMessage(focused.error)}</Notice>}
    <Card title="الأطباء والجهات">
      <div className="table-filters">
        <Field label="بحث" type="search" value={list.query}
          onChange={event=>list.setQuery(event.target.value)}
          placeholder="الاسم، الجهة، الهاتف، المفاتيح، الملاحظات"/>
        <Select label="الحالة" value={activeFilter}
          onChange={event=>setParams(prev=>{const next=new URLSearchParams(prev);next.set("active",event.target.value);next.delete("page");return next;})}>
          <option value="true">فعّال</option>
          <option value="false">مؤرشف</option>
          <option value="all">الجميع</option>
        </Select>
      </div>
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      <DataTable columns={columns} data={list.data?.items??[]} total={list.data?.total??0}
        page={list.page} pageSize={list.pageSize} onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize} sorting={list.sorting} onSortingChange={list.setSorting}
        loading={list.loading} ariaLabel="كروت الأطباء والجهات" />
    </Card>
    {mayManage&&editing!==null&&<DoctorCard key={editing==="new"?"new":editing.id}
      context={context} doctor={editing==="new"?null:editing}
      onClose={closeCard} onSaved={()=>{
        closeCard();setNotice("تم حفظ كرت الطبيب أو الجهة.");
        void list.refetch();
      }}/>}
  </>;
}

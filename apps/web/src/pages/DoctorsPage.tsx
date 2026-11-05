import { useEffect, useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from "react";
import "../doctor-inline-cells.css";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Pencil } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  doctorKinds,doctorKindLabels,doctorInputSchema,doctorPatchSchema,
  doctorInlinePatchSchema,isMainDoctorCard,
  type Doctor,type DoctorKind,type DoctorInlineField,type CompanyContext,
} from "../../../../packages/contracts/src/index";
import { api,usePagedQuery,useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import { Button,Card,DataTable,Dialog,Field,Notice,PageHeader,Select,ValueCell } from "../ui";


/** Click-to-edit cells update only the chosen attribute, never the card's name. */
function DoctorInlineCell({doctor,field,canEdit,onSaved,onFailure}:{
  doctor:Doctor;
  field:DoctorInlineField;
  canEdit:boolean;
  onSaved:()=>void;
  onFailure:(message:string)=>void;
}) {
  const labels:Record<DoctorInlineField,string>={
    sharedName:"الاسم المشترك",kind:"الفئة",department:"الجهة",
    phone:"رقم الهاتف",searchKeys:"مفاتيح البحث",notes:"ملاحظات",active:"الحالة",
  };
  const original=field==="kind"?(doctor.kind??""):
    field==="active"?(doctor.active?"true":"false"):(doctor[field]??"");
  const originalText=String(original);
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState(originalText);
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const cancelled=useRef(false);
  useEffect(()=>{if(!editing)setDraft(originalText);},[originalText,editing]);
  const shown=field==="kind"?(doctor.kind?doctorKindLabels[doctor.kind]:"بدون فئة — مراجعة"):
    field==="active"?(doctor.active?"فعّال":"مؤرشف"):
    field==="sharedName"?`${originalText||doctor.name}${isMainDoctorCard(doctor.name,doctor.sharedName)?" (رئيسي)":""}`:
    (originalText||"—");
  function cancel(){
    cancelled.current=true;
    setDraft(originalText);
    setEditing(false);
  }
  async function save(valueText:string=draft) {
    if(pending.current||cancelled.current)return;
    const value=field==="kind"?(valueText||null):
      field==="active"?(valueText==="true"):valueText.trim();
    if(value===(field==="kind"?doctor.kind:
      field==="active"?doctor.active:doctor[field])){
      setEditing(false);
      return;
    }
    const parsed=doctorInlinePatchSchema.safeParse({
      field,value,revision:doctor.revision,
    });
    if(!parsed.success){
      onFailure(parsed.error.issues[0]?.message??"تحقق من القيمة");
      return;
    }
    pending.current=true;
    setBusy(true);
    try {
      await api(`/companies/${doctor.companyId}/doctors/${doctor.id}/field`,{
        method:"PATCH",body:parsed.data,
      });
      setEditing(false);
      onSaved();
    } catch(err) {
      onFailure(`لم يحفظ ${labels[field]} لـ ${doctor.name}: ${errorMessage(err)}`);
      // Keep the new value in the editor so it isn't silently lost.
    } finally {
      pending.current=false;
      setBusy(false);
    }
  }
  if(!canEdit)return <ValueCell>{shown}</ValueCell>;
  if(!editing)return (
    <button type="button" className="doctor-inline-trigger"
      title={`تعديل ${labels[field]} مباشرة`}
      aria-label={`تعديل ${labels[field]} — ${doctor.name}`}
      onClick={()=>{
        cancelled.current=false;
        setDraft(originalText);
        setEditing(true);
      }}>
      <span className="doctor-inline-value">{shown}</span>
      <Pencil size={13} aria-hidden="true" className="doctor-inline-pencil"/>
    </button>
  );
  const select=field==="kind"||field==="active";
  if(select)return (
    <select autoFocus className="doctor-inline-editor"
      aria-label={labels[field]} disabled={busy} value={draft}
      onChange={event=>{
        setDraft(event.target.value);
        void save(event.target.value);
      }}
      onBlur={()=>{if(!pending.current)void save();}}
      onKeyDown={event=>{
        if(event.key==="Escape"){event.preventDefault();cancel();}
      }}>
      {field==="kind"?<>
        <option value="">بدون فئة — مراجعة</option>
        {doctorKinds.map(kind=><option key={kind} value={kind}>{doctorKindLabels[kind]}</option>)}
      </>:<>
        <option value="true">فعّال</option>
        <option value="false">مؤرشف</option>
      </>}
    </select>
  );
  const maxLengths:Record<Exclude<DoctorInlineField,"kind"|"active">,number>={
    sharedName:240,department:240,phone:60,searchKeys:500,notes:2000,
  };
  const textField=field as Exclude<DoctorInlineField,"kind"|"active">;
  const inputProps={
    autoFocus:true,
    className:"doctor-inline-editor",
    "aria-label":labels[field],
    disabled:busy,
    value:draft,
    maxLength:maxLengths[textField],
    onChange:(event:ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>
      setDraft(event.target.value),
    onBlur:()=>{void save();},
    onKeyDown:(event:KeyboardEvent<HTMLInputElement|HTMLTextAreaElement>)=>{
      if(event.key==="Escape"){event.preventDefault();cancel();}
      else if(event.key==="Enter"&&!(field==="notes"&&event.shiftKey)){
        event.preventDefault();void save();
      }
    },
  };
  return field==="notes"
    ? <textarea {...inputProps} rows={2}/>
    : <input {...inputProps} type={field==="phone"?"tel":"text"}/>;
}

function DoctorCard({context,doctor,onClose,onSaved}: {
  context:CompanyContext;doctor:Doctor|null;onClose:()=>void;onSaved:()=>void;
}) {
  const companyId=context.company.id;
  const guard=useScopeGuard(`company:${companyId}:doctor:${doctor?.id??"new"}`);
  const [name,setName]=useState(doctor?.name??"");
  const [sharedName,setSharedName]=useState(doctor?.sharedName??doctor?.name??"");
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
    const data = {name,sharedName:sharedName.trim()||name.trim(),kind:kind||null,department,phone,searchKeys,notes,active};
    // The revision must be included BEFORE validating an existing card.
    const parsed = doctor
      ? doctorPatchSchema.safeParse({...data,revision:doctor.revision})
      : doctorInputSchema.safeParse(data);
    if(!parsed.success){setError(parsed.error.issues[0]?.message??"تحقق من الحقول");return;}
    setSaving(true);setError("");
    try {
      await api(`/companies/${companyId}/doctors${doctor?"/"+doctor.id:""}`,{
        method:doctor?"PATCH":"POST",
        body:parsed.data,
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
        disabled={saving} onChange={event=>{
          if(!sharedName.trim()||sharedName===name)setSharedName(event.target.value);
          setName(event.target.value);
        }}/>
      <Field label="الاسم المشترك" value={sharedName} maxLength={240}
        disabled={saving} onChange={event=>setSharedName(event.target.value)}
        placeholder="اكتب الاسم الرئيسي الذي يجمع الكروت المرتبطة"/>
      <small>{isMainDoctorCard(name,sharedName)
        ? "هذا كرت رئيسي لأن الاسم يساوي الاسم المشترك."
        : "هذا الكرت مرتبط بالاسم المشترك؛ الكرت المطابق له في الاسم هو الرئيسي."}</small>
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
  const inline=(doctor:Doctor,field:DoctorInlineField)=>(
    <DoctorInlineCell doctor={doctor} field={field} canEdit={mayManage}
      onSaved={()=>{setNotice("");void list.refetch();}}
      onFailure={message=>setNotice(message)} />
  );
  const columns:ColumnDef<Doctor,unknown>[]=[
    {accessorKey:"name",header:"اسم الطبيب أو الجهة",cell:({row})=><ValueCell>{row.original.name}</ValueCell>},
    {accessorKey:"sharedName",header:"الاسم المشترك",cell:({row})=>inline(row.original,"sharedName")},
    {accessorKey:"kind",header:"الفئة",cell:({row})=>inline(row.original,"kind")},
    {accessorKey:"department",header:"الجهة",cell:({row})=>inline(row.original,"department")},
    {accessorKey:"phone",header:"رقم الهاتف",enableSorting:false,cell:({row})=>inline(row.original,"phone")},
    {accessorKey:"searchKeys",header:"مفاتيح البحث",enableSorting:false,cell:({row})=>inline(row.original,"searchKeys")},
    {accessorKey:"notes",header:"ملاحظات",enableSorting:false,cell:({row})=>inline(row.original,"notes")},
    {accessorKey:"active",header:"الحالة",cell:({row})=>inline(row.original,"active")},
    ...(mayManage?[{id:"actions",header:"الإجراء",enableSorting:false,
      cell:({row}:{row:{original:Doctor}})=><Button variant="ghost" size="compact"
        onClick={()=>setEditing(row.original)}>تعديل</Button>} satisfies ColumnDef<Doctor,unknown>]:[]),
  ];
  if(!mayView)return <Notice tone="warning">ليس لديك صلاحية عرض الأطباء والجهات.</Notice>;
  return <>
    <PageHeader title="كرت الأطباء والجهات" description="الأطباء والممرضون والجهات، دون إنشاء حساب محاسبي."
      actions={mayManage?<Button onClick={()=>setEditing("new")}>إضافة كرت</Button>:undefined}/>
    {notice&&<Notice tone={notice.startsWith("لم يحفظ")||notice.startsWith("تحقق")?"error":"success"}>{notice}</Notice>}
    {focus!==null && !mayManage && <Notice tone="warning">فتح هذا الكرت للتعديل يحتاج صلاحية إدارة الأطباء والجهات.</Notice>}
    {focused.isError && <Notice tone="error">{errorMessage(focused.error)}</Notice>}
    <Card title="الأطباء والجهات" description={mayManage?"اضغط على أي حقل لتعديله مباشرة؛ الاسم يتغير من زر «تعديل» فقط.":undefined}>
      <div className="table-filters">
        <Field label="بحث" type="search" value={list.query}
          onChange={event=>list.setQuery(event.target.value)}
          placeholder="الاسم، الاسم المشترك، الجهة، الهاتف، المفاتيح، الملاحظات"/>
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

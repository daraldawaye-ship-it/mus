import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";
import {
  generalTableSchema,
  type GeneralTableInput,
  type GeneralTableRecord,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import {
  Button, Card, DataTable, Dialog, Field, Notice, PageHeader, ValueCell,
} from "../ui";

const blank = (): GeneralTableInput => ({
  tableName: "", category: "", title: "", description: "",
  number1: null, number2: null, date1: null, date2: null,
  text1: "",
  text2: "",
  text3: "",
  text4: "",
  text5: "",
  text6: "",
  text7: "",
  text8: "",
  text9: "",
});
const localDate = (value: string | null): string | null => {
  if (!value) return null;
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
};
const fullDate = (value: string | null): string | null =>
  value ? new Date(value).toISOString() : null;
const formatDate = (value: string | null): string =>
  value ? new Intl.DateTimeFormat("ar", {dateStyle:"short",timeStyle:"short"}).format(new Date(value)) : "—";

export function GeneralTablePage() {
  const { user } = useSession();
  if (!user || !(user.owner || user.kind === "admin"))
    return <Notice tone="warning">إدارة الجدول العام لمالك المنصة وإدارة الموقع فقط.</Notice>;
  return <GeneralTableContent />;
}

type NumericColumn = "number1" | "number2";
function InlineNumber({
  record, field, onSave,
}: {
  record:GeneralTableRecord;
  field:NumericColumn;
  onSave:(record:GeneralTableRecord,field:NumericColumn,value:string|null)=>Promise<boolean>;
}) {
  const original = record[field] ?? "";
  const [draft,setDraft] = useState(original);
  const [saving,setSaving] = useState(false);
  const skipBlur=useRef(false);
  useEffect(()=>{if(!saving)setDraft(original);},[original]);
  async function commit() {
    if(skipBlur.current){skipBlur.current=false;return;}
    if(saving)return;
    const value=draft.trim() || null;
    if(value===record[field])return;
    const parsed=generalTableSchema.shape.number1.safeParse(value);
    if(!parsed.success){
      // The API and the item card share the same decimal constraints.
      // Keep focus until the user corrects invalid input.
      return;
    }
    setSaving(true);
    try {
      const ok=await onSave(record,field,parsed.data);
      if(!ok)return;
      setDraft(parsed.data ?? "");
    }finally{setSaving(false);}
  }
  const candidate=draft.trim() || null;
  const valid=generalTableSchema.shape.number1.safeParse(candidate).success;
  return <input type="text" inputMode="decimal" className="general-table-inline-number"
    aria-label={`تعديل ${field==="number1"?"الرقم 1":"الرقم 2"} للسجل ${record.id}`}
    title={valid ? "عدّل الرقم ثم اضغط Enter أو غادر الحقل للحفظ" :
      "رقم غير صالح: حتى 24 رقمًا و8 منازل عشرية"}
    aria-invalid={!valid || undefined}
    disabled={saving}
    value={draft} placeholder="—"
    onChange={event=>setDraft(event.target.value)}
    onBlur={()=>{void commit();}}
    onKeyDown={event=>{
      if(event.key==="Enter"){
        event.preventDefault();
        event.currentTarget.blur();
      }else if(event.key==="Escape"){
        event.preventDefault();
        skipBlur.current=true;
        setDraft(original);
        event.currentTarget.blur();
      }
    }}/>;
}

function GeneralTableContent() {
  const { user } = useSession();
  const guard = useScopeGuard("public:general-table");
  const [params, setParams] = useSearchParams();
  const tableName = params.get("tableName") ?? "";
  const category = params.get("category") ?? "";
  const filters = new URLSearchParams();
  if (tableName) filters.set("tableName", tableName);
  if (category) filters.set("category", category);
  const list = usePagedQuery<GeneralTableRecord>(
    `/general-table?${filters}`, "public:general-table",
  );
  const [editor, setEditor] = useState<GeneralTableRecord | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [duplicating, setDuplicating] = useState(false);
  const [savingNumber, setSavingNumber] = useState<string | null>(null);
  async function duplicateSelected() {
    if (duplicating || !selectedIds.length || selectedIds.length > 100) return;
    setError("");
    setNotice("");
    setDuplicating(true);
    try {
      const result = await api<{ created: number }>("/general-table/duplicate", {
        method: "POST",
        body: { ids: selectedIds.map(Number) },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setSelectedIds([]);
      setSelectionEpoch((value) => value + 1);
      setNotice(`تم تكرار ${result.created} سجل بنجاح؛ احتُفظ بالسجلات الأصلية.`);
      void list.refetch();
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setDuplicating(false);
    }
  }
  async function saveNumber(record:GeneralTableRecord,field:NumericColumn,value:string|null) {
    if(savingNumber !== null)return false;
    setError("");setNotice("");
    setSavingNumber(`${record.id}:${field}`);
    try {
      const result=await api<{record:GeneralTableRecord}>(
        `/general-table/${record.id}/number`,{
          method:"PATCH",
          body:{field,value,expectedValue:record[field]},
          signal:guard.signal,
        },
      );
      if(!guard.isCurrent())return false;
      setNotice(`تم تحديث ${field==="number1"?"الرقم 1":"الرقم 2"} للسجل رقم ${result.record.id}.`);
      await list.refetch();
      return true;
    }catch(cause){
      if(guard.isCurrent())setError(`تعذر حفظ الرقم في السجل ${record.id}: ${errorMessage(cause)}`);
      return false;
    }finally{
      if(guard.isCurrent())setSavingNumber(null);
    }
  }
  const columns: ColumnDef<GeneralTableRecord, unknown>[] = [
    { accessorKey:"id",header:"الرقم",size:85 },
    { accessorKey:"tableName",header:"اسم الجدول / الاستخدام",size:190,
      cell:({row})=><ValueCell>{row.original.tableName}</ValueCell> },
    { accessorKey:"category",header:"التصنيف",size:150,
      cell:({row})=><ValueCell>{row.original.category || "—"}</ValueCell> },
    { accessorKey:"title",header:"العنوان",size:230,
      cell:({row})=><ValueCell>{row.original.title}</ValueCell> },
    { accessorKey:"number1",header:"الرقم 1",size:140,
      cell:({row})=><InlineNumber key={row.original.id+":number1"}
        record={row.original} field="number1" onSave={saveNumber}/> },
    { accessorKey:"number2",header:"الرقم 2",size:140,
      cell:({row})=><InlineNumber key={row.original.id+":number2"}
        record={row.original} field="number2" onSave={saveNumber}/> },
    { id:"description",header:"الوصف",size:260,enableSorting:false,
      cell:({row})=><ValueCell value={row.original.description}>{row.original.description || "—"}</ValueCell> },
    { accessorKey:"updatedAt",header:"آخر تعديل",size:170,
      cell:({row})=>formatDate(row.original.updatedAt) },
    { id:"actions",header:"الإجراءات",size:100,enableSorting:false,
      cell:({row})=><Button size="compact" variant="secondary" onClick={()=>{setError("");setEditor(row.original);}}
        aria-label={`تعديل السجل ${row.original.id}`}>تعديل</Button> },
  ];
  const changeFilter = (key: "tableName" | "category", value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value.trim() ? next.set(key, value.trim()) : next.delete(key);
      next.delete("page");
      return next;
    });
  return <>
    <PageHeader title="الجدول العام"
      description="سجلات مرنة لاستخدامات متعددة؛ تُحدد وظيفة كل مجموعة من خلال اسم الجدول والتصنيف."
      actions={<>
        <Button variant="secondary"
          disabled={duplicating || !selectedIds.length || selectedIds.length > 100}
          onClick={() => void duplicateSelected()}>
          {duplicating ? "جارٍ التكرار…" : `تكرار المحدد (${selectedIds.length})`}
        </Button>
        <Button disabled={duplicating} onClick={()=>{setError("");setEditor("new");}}>إضافة سجل</Button>
      </>} />
    <Notice>هذه السجلات ضمن إدارة الموقع العام حاليًا، وليست ظاهرة للجمهور أو مرتبطة بشركة. يمكن ربط استخداماتها بوحدات أخرى لاحقًا.</Notice>
    {notice && <Notice tone="success">{notice}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <Card title="السجلات">
      <div className="table-filters">
        <Field label="بحث" value={list.query} type="search" placeholder="العنوان أو الوصف أو التصنيف"
          onChange={event=>list.setQuery(event.target.value)}/>
        <Field label="اسم الجدول" value={tableName} maxLength={120} placeholder="جميع الاستخدامات"
          onChange={event=>changeFilter("tableName",event.target.value)}/>
        <Field label="التصنيف" value={category} maxLength={120} placeholder="كل التصنيفات"
          onChange={event=>changeFilter("category",event.target.value)}/>
      </div>
      {selectedIds.length > 100 && <Notice tone="warning">يمكن تكرار 100 سجل كحد أقصى في كل عملية. ألغِ تحديد بعض السجلات.</Notice>}
      {list.error && <Notice tone="error">{errorMessage(list.error)}
        {" "}<Button variant="ghost" onClick={()=>void list.refetch()}>إعادة المحاولة</Button>
      </Notice>}
      <DataTable key={selectionEpoch} columns={columns} data={list.data?.items??[]} total={list.data?.total??0}
        selectionMode="multi" onSelectionChange={setSelectedIds}
        getRowId={(row) => String(row.id)}
        page={list.page} pageSize={list.pageSize} onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize} sorting={list.sorting}
        onSortingChange={list.setSorting} loading={list.loading || savingNumber !== null}
        ariaLabel="سجلات الجدول العام" />
    </Card>
    {editor && <GeneralTableEditor key={editor==="new"?"new":editor.id} record={editor==="new"?null:editor}
      onClose={()=>setEditor(null)} onSaved={(saved, created)=>{
        if(!guard.isCurrent())return;
        setEditor(null);
        setNotice(created ? `تمت إضافة السجل رقم ${saved.id}.` : `تم حفظ تعديل السجل رقم ${saved.id}.`);
        void list.refetch();
      }} />}
  </>;
}

function GeneralTableEditor({
  record, onClose, onSaved,
}: {
  record: GeneralTableRecord | null;
  onClose: () => void;
  onSaved: (record:GeneralTableRecord,created:boolean)=>void;
}) {
  const guard = useScopeGuard("public:general-table:edit");
  const [draft,setDraft] = useState<GeneralTableInput>(() => record ? ({
    tableName:record.tableName,category:record.category,title:record.title,
    description:record.description,number1:record.number1,number2:record.number2,
    date1:localDate(record.date1),date2:localDate(record.date2),
    text1:record.text1,
    text2:record.text2,
    text3:record.text3,
    text4:record.text4,
    text5:record.text5,
    text6:record.text6,
    text7:record.text7,
    text8:record.text8,
    text9:record.text9,
  }) : blank());
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(saving)return;
    setError("");
    const prepared={
      ...draft,
      number1:draft.number1?.trim() || null,
      number2:draft.number2?.trim() || null,
      date1:fullDate(draft.date1),
      date2:fullDate(draft.date2),
    };
    const parsed=generalTableSchema.safeParse(prepared);
    if(!parsed.success) {setError(parsed.error.issues[0]?.message || "تحقق من الحقول");return;}
    setSaving(true);
    try {
      const result=await api<{record:GeneralTableRecord}>(record?`/general-table/${record.id}`:"/general-table",{
        method:record?"PATCH":"POST",body:parsed.data,signal:guard.signal,
      });
      if(guard.isCurrent())onSaved(result.record,!record);
    } catch(cause) {if(guard.isCurrent())setError(errorMessage(cause));}
    finally {if(guard.isCurrent())setSaving(false);}
  }
  return <Dialog open title={record?`تعديل السجل رقم ${record.id}`:"إضافة سجل في الجدول العام"}
    onClose={()=>{if(!saving)onClose();}}>
    <form className="form-stack" onSubmit={event=>void submit(event)}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-grid">
        <Field label="اسم الجدول (general_table_table_name)" value={draft.tableName}
          maxLength={120} required disabled={saving} autoFocus
          onChange={event=>setDraft({...draft,tableName:event.target.value})}/>
        <Field label="التصنيف (general_table_category)" value={draft.category}
          maxLength={120} disabled={saving}
          onChange={event=>setDraft({...draft,category:event.target.value})}/>
        <Field className="form-full" label="العنوان (general_table_title)" value={draft.title}
          maxLength={200} required disabled={saving}
          onChange={event=>setDraft({...draft,title:event.target.value})}/>
        <div className="field form-full">
          <label htmlFor="general-description">الوصف (general_table_description)</label>
          <textarea id="general-description" rows={4} maxLength={12000} disabled={saving}
            style={{height:104,padding:8}} value={draft.description}
            onChange={event=>setDraft({...draft,description:event.target.value})}/>
        </div>
        {(["number1","number2"] as const).map((key,index)=>
          <Field key={key} label={`رقم ${index+1} (general_table_${key})`}
            value={draft[key]??""} inputMode="decimal" placeholder="اختياري" disabled={saving}
            onChange={event=>setDraft({...draft,[key]:event.target.value||null})}/>)}
        {(["date1","date2"] as const).map((key,index)=>
          <Field key={key} type="datetime-local" label={`تاريخ ${index+1} (general_table_${key})`}
            value={draft[key]??""} disabled={saving}
            onChange={event=>setDraft({...draft,[key]:event.target.value||null})}/>)}
      </div>
      <details>
        <summary>الحقول النصية الإضافية (text1 إلى text9)</summary>
        <div className="form-stack" style={{paddingBlockStart:12}}>
          <div className="field" key="text1"><label htmlFor="general-table-text1">نص 1 (general_table_text1)</label>
            <textarea id="general-table-text1" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text1} disabled={saving} onChange={(event) => setDraft({...draft,text1:event.target.value})}/>
          </div>
          <div className="field" key="text2"><label htmlFor="general-table-text2">نص 2 (general_table_text2)</label>
            <textarea id="general-table-text2" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text2} disabled={saving} onChange={(event) => setDraft({...draft,text2:event.target.value})}/>
          </div>
          <div className="field" key="text3"><label htmlFor="general-table-text3">نص 3 (general_table_text3)</label>
            <textarea id="general-table-text3" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text3} disabled={saving} onChange={(event) => setDraft({...draft,text3:event.target.value})}/>
          </div>
          <div className="field" key="text4"><label htmlFor="general-table-text4">نص 4 (general_table_text4)</label>
            <textarea id="general-table-text4" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text4} disabled={saving} onChange={(event) => setDraft({...draft,text4:event.target.value})}/>
          </div>
          <div className="field" key="text5"><label htmlFor="general-table-text5">نص 5 (general_table_text5)</label>
            <textarea id="general-table-text5" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text5} disabled={saving} onChange={(event) => setDraft({...draft,text5:event.target.value})}/>
          </div>
          <div className="field" key="text6"><label htmlFor="general-table-text6">نص 6 (general_table_text6)</label>
            <textarea id="general-table-text6" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text6} disabled={saving} onChange={(event) => setDraft({...draft,text6:event.target.value})}/>
          </div>
          <div className="field" key="text7"><label htmlFor="general-table-text7">نص 7 (general_table_text7)</label>
            <textarea id="general-table-text7" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text7} disabled={saving} onChange={(event) => setDraft({...draft,text7:event.target.value})}/>
          </div>
          <div className="field" key="text8"><label htmlFor="general-table-text8">نص 8 (general_table_text8)</label>
            <textarea id="general-table-text8" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text8} disabled={saving} onChange={(event) => setDraft({...draft,text8:event.target.value})}/>
          </div>
          <div className="field" key="text9"><label htmlFor="general-table-text9">نص 9 (general_table_text9)</label>
            <textarea id="general-table-text9" rows={3} maxLength={12000} style={{height: 90,padding: 8}}
              value={draft.text9} disabled={saving} onChange={(event) => setDraft({...draft,text9:event.target.value})}/>
          </div>
        </div>
      </details>
      <div className="form-actions">
        <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ السجل"}</Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Dialog>;
}

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Notice } from "../ui";

type Source = { id: string; filename: string; metadata?: { sheets?: { name: string }[] } };
type Progress = "unprocessed" | "partial" | "complete";
type Row = {
  section: string; position: number; payload_text: string; followup_status: Progress;
  completed_fields: string[]; remaining_fields: string[];
  card_refs: { kind: string; id: number }[];
  followup_notes: string; followup_revision: number;
};
const labels: Record<Progress, string> = {
  unprocessed: "لم يُتابَع", partial: "متابعة جزئية", complete: "متابعة كلية",
};
const fields = (s: string) =>
  [...new Set(s.split(/[،,\n]/).map(x => x.trim()).filter(Boolean))].slice(0, 40);
function preview(raw: string): string {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof p.text === "string" ? p.text
      : Array.isArray(p.text) ? p.text.map((v: unknown) =>
        typeof v === "string" ? v
          : typeof v === "object" && v && "text" in v
            ? String((v as {text?: unknown}).text ?? "") : "").join("")
      : Array.isArray(p.cells) ? p.cells.map((v: unknown) =>
        typeof v === "object" && v && "value" in v
          ? String((v as {value?: unknown}).value ?? "") : "").filter(Boolean).join(" | ")
      : raw;
    return text.replace(/\s+/g, " ").slice(0, 700);
  } catch { return raw.slice(0, 700); }
}
export function MarketStagingProgress() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState("5");
  const [section, setSection] = useState("messages");
  const [filter, setFilter] = useState<"all" | Progress>("unprocessed");
  const [after, setAfter] = useState(0);
  const [selected, setSelected] = useState<Row | null>(null);
  const [status, setStatus] = useState<"partial" | "complete">("partial");
  const [done, setDone] = useState("");
  const [remaining, setRemaining] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const sources = useQuery({
    queryKey: ["market-staging-followup","sources"],
    queryFn: ({signal}) => api<{sources: Source[]}>("/medicine-market/staging", {signal}),
    enabled: open,
  });
  const rows = useQuery({
    queryKey: ["market-staging-followup",sourceId,section,filter,after],
    queryFn: ({signal}) => api<{items: Row[]}>(
      "/medicine-market/staging/" + sourceId + "/rows?" +
      new URLSearchParams({section,workStatus:filter,after:String(after),pageSize:"20"}), {signal}),
    enabled: open,
  });
  const summary = useQuery({
    queryKey: ["market-staging-followup","summary",sourceId,section],
    queryFn: ({signal}) => api<{total:number;unprocessed:number;partial:number;complete:number}>(
      "/medicine-market/staging/" + sourceId + "/followup-summary?" +
      new URLSearchParams({section}), {signal}),
    enabled: open,
  });
  const choose=(row:Row)=>{
    setSelected(row);setStatus(row.followup_status==="complete"?"complete":"partial");
    setDone(row.completed_fields.join("، "));setRemaining(row.remaining_fields.join("، "));
    setNotes(row.followup_notes);setFeedback("");
  };
  const save=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();if(!selected||saving)return;setSaving(true);setFeedback("");
    try{
      await api("/medicine-market/staging/"+sourceId+"/followups",{
        method:"POST",body:{entries:[{
          section,position:selected.position,status,
          completedFields:fields(done),remainingFields:fields(remaining),
          cardRefs:selected.card_refs,notes:notes.trim(),
          expectedRevision:selected.followup_revision,
        }]},
      });
      setFeedback("حُفظت حالة متابعة السجل "+selected.position);
      setSelected(null);
      await client.invalidateQueries({queryKey:["market-staging-followup"]});
    }catch(error){
      setFeedback(error instanceof Error?error.message:"تعذر حفظ المتابعة");
    }finally{setSaving(false);}
  };
  return <details onToggle={e=>setOpen(e.currentTarget.open)} style={{marginBlockStart:16}}>
    <summary>متابعة الجداول المؤقتة — غير متابع / جزئي / كلي</summary>
    <p className="medicine-market-muted">تُحفظ المتابعة دون تغيير المصدر. اختر غير المتابع أو الجزئي لاستكمال العمل بدل إعادة البحث في السجلات المكتملة.</p>
    <div className="page-actions" style={{flexWrap:"wrap"}}>
      <label>المصدر
        <select value={sourceId} onChange={e=>{
          const id=e.target.value,source=sources.data?.sources.find(x=>x.id===id);
          setSourceId(id);setSection(source?.metadata?.sheets?.[0]?.name??"messages");
          setAfter(0);setSelected(null);
        }}>{sources.data?.sources.map(x=><option key={x.id} value={x.id}>{x.filename}</option>)}</select>
      </label>
      <label>الورقة/القسم
        <input value={section} maxLength={500} onChange={e=>{
          setSection(e.target.value);setAfter(0);setSelected(null);
        }}/>
      </label>
      <label>الحالة
        <select value={filter} onChange={e=>{
          setFilter(e.target.value as typeof filter);setAfter(0);setSelected(null);
        }}>
          <option value="unprocessed">لم يُتابَع</option>
          <option value="partial">جزئي</option>
          <option value="complete">كلي</option>
          <option value="all">الكل</option>
        </select>
      </label>
    </div>
    {summary.data&&<p className="medicine-market-muted">
      الإجمالي {summary.data.total} · غير متابع {summary.data.unprocessed} · جزئي {summary.data.partial} · كلي {summary.data.complete}
    </p>}
    {(sources.error||rows.error||summary.error)&&<Notice tone="error">تعذر تحميل بعض بيانات متابعة السجلات.</Notice>}
    {feedback&&<Notice>{feedback}</Notice>}
    {(rows.data?.items??[]).map(row=><div key={row.section+":"+row.position}
      style={{borderBlockStart:"1px solid #aaa",paddingBlock:12}}>
      <strong>السجل {row.position} — {labels[row.followup_status]}</strong>
      <p style={{overflowWrap:"anywhere"}}>{preview(row.payload_text)}</p>
      {row.completed_fields.length>0&&<small>المستخرج: {row.completed_fields.join("، ")}</small>}
      {row.remaining_fields.length>0&&<p className="medicine-market-muted">المتبقي: {row.remaining_fields.join("، ")}</p>}
      <Button size="compact" variant="secondary" onClick={()=>choose(row)}>تحديث متابعة السجل</Button>
    </div>)}
    <div className="page-actions">
      <Button size="compact" variant="secondary" disabled={after===0} onClick={()=>{
        setAfter(0);setSelected(null);
      }}>البداية</Button>
      <Button size="compact" variant="secondary" disabled={!rows.data||rows.data.items.length<20}
        onClick={()=>{setAfter(rows.data?.items.at(-1)?.position??after);setSelected(null);}}>العشرون التالية</Button>
    </div>
    {selected&&<form className="stack" onSubmit={e=>void save(e)}>
      <h3>متابعة السجل {selected.position}</h3>
      <label>الحالة
        <select value={status} onChange={e=>setStatus(e.target.value as typeof status)}>
          <option value="partial">تمت متابعة السجل جزئيًا</option>
          <option value="complete">تمت متابعة السجل كليًا</option>
        </select>
      </label>
      <label>البيانات التي أُخذت، مفصولة بفواصل
        <input value={done} onChange={e=>setDone(e.target.value)}/>
      </label>
      <label>البيانات المتبقية
        <input value={remaining} onChange={e=>setRemaining(e.target.value)}/>
      </label>
      <label>ملاحظات المتابعة
        <textarea value={notes} maxLength={2000} rows={2} onChange={e=>setNotes(e.target.value)}/>
      </label>
      {status==="complete"&&fields(remaining).length>0&&<Notice tone="error">
        امسح قائمة البيانات المتبقية قبل اعتماد المتابعة الكلية.
      </Notice>}
      <div className="page-actions">
        <Button type="submit" disabled={saving||(status==="complete"&&fields(remaining).length>0)}>
          {saving?"جارٍ الحفظ…":"حفظ المتابعة"}
        </Button>
        <Button variant="secondary" disabled={saving} onClick={()=>setSelected(null)}>إلغاء</Button>
      </div>
    </form>}
  </details>;
}

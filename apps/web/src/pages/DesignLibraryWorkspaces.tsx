import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Filter, Layers, Plus, RotateCcw, Search, X } from "lucide-react";
import "./DesignLibraryWorkspaces.css";

// Original local examples inspired by the observed Dreams Core Leads layout.
// No API calls, external scripts, customer data, storage writes, or financial actions.
type Stage = "new" | "review" | "done";
type DemoOrder = { id: number; name: string; supplier: string; stage: Stage; value: number; priority: "normal" | "high" };
const STAGES: { key: Stage; label: string }[] = [
  { key: "new", label: "جديد" }, { key: "review", label: "قيد المراجعة" }, { key: "done", label: "مكتمل" },
];
const INITIAL: DemoOrder[] = [
  { id: 101, name: "طلب مستلزمات تجريبي", supplier: "مورد تجريبي أ", stage: "new", value: 12000, priority: "high" },
  { id: 102, name: "طلب أصناف تجريبي", supplier: "مورد تجريبي ب", stage: "new", value: 8000, priority: "normal" },
  { id: 103, name: "مسودة شراء تجريبية", supplier: "مورد تجريبي أ", stage: "review", value: 5000, priority: "normal" },
  { id: 104, name: "طلب مكتمل تجريبي", supplier: "مورد تجريبي ج", stage: "done", value: 10000, priority: "normal" },
];
const number = new Intl.NumberFormat("ar-YE", { maximumFractionDigits: 0 });
const stageLabel = (key: Stage) => STAGES.find(s => s.key === key)!.label;

function Example({ code, title, note, wide = false, children }: {
  code: string; title: string; note: string; wide?: boolean; children: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${title} — ${code}`); setCopyState("ok"); }
    catch { setCopyState("failed"); }
  };
  return <article id={`design-${code}`} className={`design-sample dw-example${wide ? " dw-wide" : ""}`}>
    <header className="design-sample-heading">
      <div><strong>{title}</strong><span className="design-sample-code">{code}</span></div>
      <button type="button" className="design-copy" onClick={() => void copy()} aria-label={`نسخ ${title}`}>
        {copyState === "ok" ? <Check size={13} /> : <Copy size={13} />} {copyState === "ok" ? "نُسخ" : "نسخ الاسم"}
      </button>
    </header>
    <div className="design-sample-body">{children}</div>
    <p className="design-sample-note">{note}</p>
    {copyState === "failed" && <label className="dw-field">تعذر النسخ التلقائي؛ انسخ الاسم هنا<input readOnly value={`${title} — ${code}`} onFocus={e => e.currentTarget.select()} /></label>}
  </article>;
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="design-group"><div className="design-group-heading"><h2>{title}</h2></div><div className="design-sample-grid">{children}</div></section>;
}
function Badge({ stage }: { stage: Stage }) { return <span className={`dw-badge dw-${stage}`}>{stageLabel(stage)}</span>; }
function DemoDialog({ open, onClose, title, side = false, children }: {
  open: boolean; onClose: () => void; title: string; side?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const noteId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`dw-dialog${side ? " dw-drawer" : ""}`} aria-labelledby={titleId} aria-describedby={noteId}
    onCancel={e => { e.preventDefault(); onClose(); }} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dw-dialog-content">
      <header className="dw-dialog-heading"><h3 id={titleId}>{title}</h3><button type="button" className="button button-secondary button-compact" onClick={onClose} aria-label="إغلاق النافذة"><X size={16} /></button></header>
      <p id={noteId} className="dw-muted">معاينة ببيانات تجريبية — لا تُحفظ في الموقع.</p>
      {children}
    </div>
  </dialog>;
}
function Summary() {
  return <div className="dw-metrics" aria-label="ملخص طلبات تجريبي">
    {[{ name: "كل الطلبات", value: INITIAL.length }, ...STAGES.map(s => ({ name: s.label, value: INITIAL.filter(r => r.stage === s.key).length }))].map(m =>
      <div key={m.name}><span>{m.name}</span><strong>{number.format(m.value)}</strong><small>بيانات توضيحية</small></div>)}
  </div>;
}
function SectionHeader() {
  const [count, setCount] = useState(4);
  return <div className="dw-toolbar"><div><strong>مسودات الطلبات <span className="dw-count">{count}</span></strong><small>عنوان وعدد وأوامر في حزام واحد</small></div>
    <div className="dw-inline"><button type="button" className="button button-primary button-compact" onClick={() => setCount(n => n + 1)}><Plus size={13} /> إضافة تجريبية</button>
      <button type="button" className="button button-secondary button-compact" onClick={() => setCount(4)} aria-label="إعادة العداد إلى أربعة"><RotateCcw size={13} /></button></div>
  </div>;
}
function QuickFilters() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const matches = INITIAL.filter(r => (status === "all" || r.stage === status) && `${r.name} ${r.supplier}`.includes(query.trim()));
  return <div className="dw-fill"><div className="dw-filter-row">
    <label className="dw-field">بحث في الطلبات<span className="dw-search"><Search size={14} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="اسم الطلب أو المورد" /></span></label>
    <label className="dw-field">الحالة<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">كل الحالات</option>{STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
  </div><ul className="dw-result-list">{matches.map(r => <li key={r.id}><span>{r.name}</span><Badge stage={r.stage} /></li>)}</ul>
    <p className="dw-muted" role="status">{matches.length ? `${matches.length} نتائج تجريبية` : "لا توجد نتائج مطابقة"}</p></div>;
}
function ActiveFilters() {
  const original = ["الحالة: جديد", "الأولوية: مرتفعة", "المورد: تجريبي أ"];
  const [filters, setFilters] = useState(original);
  return <div className="dw-fill"><div className="dw-inline"><strong>الفلاتر النشطة <span className="dw-count">{filters.length}</span></strong><button type="button" className="button button-ghost button-compact" onClick={() => setFilters(filters.length ? [] : original)}>{filters.length ? "مسح الكل" : "إعادة المثال"}</button></div>
    <div className="dw-chips">{filters.map(f => <button key={f} type="button" onClick={() => setFilters(old => old.filter(x => x !== f))} aria-label={`إزالة فلتر ${f}`}>{f}<X size={12} /></button>)}</div>
    {!filters.length && <p className="dw-muted" role="status">لا توجد فلاتر نشطة.</p>}</div>;
}
function AdvancedFilters() {
  const [open, setOpen] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [supplier, setSupplier] = useState("all");
  const [high, setHigh] = useState(false);
  const [applied, setApplied] = useState("لم تُطبّق تصفية بعد.");
  const count = stages.length + Number(supplier !== "all") + Number(high);
  const matches = INITIAL.filter(r => (!stages.length || stages.includes(r.stage)) && (supplier === "all" || r.supplier === supplier) && (!high || r.priority === "high"));
  const reset = () => { setStages([]); setSupplier("all"); setHigh(false); };
  return <><button type="button" className="button button-secondary" onClick={() => setOpen(true)}><Filter size={14} /> فلاتر متقدمة <span className="dw-count">{count}</span></button><small className="dw-muted" role="status">{applied}</small>
    <DemoDialog open={open} onClose={() => setOpen(false)} title="الفلاتر المتقدمة" side>
      <form className="dw-stack" onSubmit={e => { e.preventDefault(); setApplied(`تمت معاينة ${matches.length} نتائج تجريبية.`); setOpen(false); }}>
        <div className="dw-inline"><strong>{count} فلاتر نشطة</strong><button type="button" className="button button-ghost button-compact" onClick={reset}>مسح الكل</button></div>
        <fieldset><legend>حالة الطلب</legend><div className="dw-stack">{STAGES.map(s => <label key={s.key} className="dw-check"><input type="checkbox" checked={stages.includes(s.key)} onChange={e => setStages(old => e.target.checked ? [...old, s.key] : old.filter(x => x !== s.key))} />{s.label}</label>)}</div></fieldset>
        <label className="dw-field">المورد<select value={supplier} onChange={e => setSupplier(e.target.value)}><option value="all">كل الموردين</option>{[...new Set(INITIAL.map(r => r.supplier))].map(v => <option key={v}>{v}</option>)}</select></label>
        <label className="dw-check"><input type="checkbox" checked={high} onChange={e => setHigh(e.target.checked)} />الأولوية المرتفعة فقط</label>
        <div className="dw-dialog-footer"><button type="submit" className="button button-primary">عرض {matches.length} نتائج تجريبية</button><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>إغلاق</button></div>
      </form>
    </DemoDialog></>;
}
function DateRange() {
  const [from, setFrom] = useState("2026-11-01");
  const [to, setTo] = useState("2026-11-14");
  const invalid = !!from && !!to && from > to;
  return <div className="dw-fill"><div className="dw-inline"><button type="button" className="button button-secondary button-compact" onClick={() => { setFrom("2026-11-14"); setTo("2026-11-14"); }}>يوم المثال</button><button type="button" className="button button-secondary button-compact" onClick={() => { setFrom("2026-11-01"); setTo("2026-11-14"); }}>شهر المثال</button><button type="button" className="button button-ghost button-compact" onClick={() => { setFrom(""); setTo(""); }}>كل الفترة</button></div>
    <div className="dw-filter-row"><label className="dw-field">من<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="dw-field">إلى<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>
    <p className={invalid ? "dw-error" : "dw-muted"} role="status">{invalid ? "تاريخ البداية يجب ألا يتجاوز النهاية." : "نطاق للعرض فقط — التاريخ المثبت مثال وليس اليوم الحالي."}</p></div>;
}
function OrderBoard() {
  const [orders, setOrders] = useState(INITIAL);
  const [message, setMessage] = useState("");
  return <div className="dw-fill"><div className="dw-board-scroll" role="region" aria-label="لوحة مراحل الطلبات التجريبية" tabIndex={0}>
    <div className="dw-board">{STAGES.map(s => {
      const rows = orders.filter(r => r.stage === s.key);
      return <section key={s.key} className="dw-lane"><header><strong>{s.label}<span className="dw-count">{rows.length}</span></strong><small>{number.format(rows.reduce((sum, r) => sum + r.value, 0))} ر.ي — قيمة تجريبية</small></header>
        {rows.map(r => <div className="dw-order-card" key={r.id}><strong>{r.name}</strong><small>{r.supplier}</small><div className="dw-inline"><span>{number.format(r.value)} ر.ي</span>{r.priority === "high" && <span className="dw-badge dw-high">أولوية مرتفعة</span>}</div>
          <label className="dw-field">نقل إلى مرحلة<select value={r.stage} onChange={e => { const next = e.target.value as Stage; setOrders(old => old.map(v => v.id === r.id ? { ...v, stage: next } : v)); setMessage(`نُقل ${r.name} إلى ${stageLabel(next)} داخل المثال فقط.`); }}>{STAGES.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
        </div>)}
        {!rows.length && <p className="dw-empty">لا توجد طلبات في هذه المرحلة.</p>}
      </section>;
    })}</div></div><div className="dw-inline"><button type="button" className="button button-secondary button-compact" onClick={() => { setOrders(INITIAL); setMessage("أُعيدت لوحة المثال."); }}>إعادة المثال</button><span className="dw-muted" role="status">{message}</span></div></div>;
}
function CompactCard() {
  return <div className="dw-order-card dw-fill"><div className="dw-card-top"><strong>طلب مستلزمات تجريبي</strong><Badge stage="review" /></div><small>مرجع 101 · مورد تجريبي أ</small><dl className="dw-details"><dt>القيمة</dt><dd>12,000 ر.ي</dd><dt>المسؤول</dt><dd>موظف تجريبي</dd></dl>
    <details className="dw-fold"><summary>إظهار التفاصيل</summary><p>3 أصناف توضيحية. المعلومات والأرقام هنا لا تخص طلبًا حقيقيًا.</p></details></div>;
}
function RecordPreview() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const row = INITIAL[index];
  return <><div className="dw-result-list dw-fill">{INITIAL.slice(0, 2).map((r, i) => <div key={r.id} className="dw-record-row"><span>{r.name}</span><button type="button" className="button button-secondary button-compact" onClick={() => { setIndex(i); setOpen(true); }}>معاينة</button></div>)}</div>
    <DemoDialog open={open} onClose={() => setOpen(false)} title="معاينة الطلب" side>
      <h4>{row.name}</h4><Badge stage={row.stage} /><dl className="dw-details"><dt>الرقم</dt><dd>{row.id}</dd><dt>المورد</dt><dd>{row.supplier}</dd><dt>القيمة</dt><dd>{number.format(row.value)} ر.ي</dd></dl>
      <div className="dw-dialog-footer"><button type="button" className="button button-secondary" disabled={index === 0} onClick={() => setIndex(i => i - 1)}>السابق</button><span>{index + 1} / {INITIAL.length}</span><button type="button" className="button button-secondary" disabled={index === INITIAL.length - 1} onClick={() => setIndex(i => i + 1)}>التالي</button></div>
    </DemoDialog></>;
}
function Priority() {
  const [priority, setPriority] = useState("عادية");
  return <div className="dw-fill"><div className="dw-priorities" role="group" aria-label="أولوية الطلب التجريبي">{["مرتفعة", "عادية", "منخفضة"].map(p => <button type="button" key={p} aria-pressed={priority === p} className={priority === p ? "is-selected" : ""} onClick={() => setPriority(p)}>{priority === p && <Check size={12} />}{p}</button>)}</div><p className="dw-muted" role="status">الأولوية المختارة: {priority}</p></div>;
}
function ExportScope() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("المعروض بعد التصفية");
  const [message, setMessage] = useState("");
  const groupName = useId();
  return <><button type="button" className="button button-secondary" onClick={() => setOpen(true)}>خيارات التصدير</button><span className="dw-muted" role="status">{message}</span>
    <DemoDialog open={open} onClose={() => setOpen(false)} title="نطاق التصدير التجريبي"><form className="dw-stack" onSubmit={e => { e.preventDefault(); setMessage(`اختيار تجريبي: ${scope}. لم يُنشأ ملف ولم تُرسل بيانات.`); setOpen(false); }}>
      {["جميع السجلات", "المعروض بعد التصفية", "السجلات المحددة (مثال: 2)"].map(s => <label className="dw-check" key={s}><input type="radio" name={groupName} checked={scope === s} onChange={() => setScope(s)} />{s}</label>)}
      <div className="dw-dialog-footer"><button type="submit" className="button button-primary">معاينة الاختيار فقط</button><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>إلغاء</button></div>
    </form></DemoDialog></>;
}
function FollowupList() {
  const [done, setDone] = useState<number[]>([2]);
  return <div className="dw-fill"><div className="dw-inline"><strong>المتابعات التجريبية</strong><span className="dw-count">{done.length} / 3</span></div>
    <ul className="dw-followups">{["مراجعة طلب المورد", "مطابقة مسودة الشراء", "متابعة استلام الطلب"].map((text, i) => <li key={text}><label className="dw-check"><input type="checkbox" checked={done.includes(i)} onChange={e => setDone(old => e.target.checked ? [...old, i] : old.filter(v => v !== i))} /><span className={done.includes(i) ? "dw-completed" : ""}>{text}<small>مسؤول تجريبي {i + 1} · موعد توضيحي</small></span></label><span className="dw-muted">{done.includes(i) ? "مراجع" : "غير مراجع"}</span></li>)}</ul>
    <p className="dw-muted" role="status">{done.length} متابعة مراجعة في هذا المثال.</p></div>;
}

export default function DesignLibraryWorkspaces() {
  const [revision, setRevision] = useState(0);
  return <div className="design-workspaces">
    <div className="dw-source"><div><Layers size={17} /><span>أفكار من صفحة Leads في <a href="https://dreamscore.dreamstechnologies.com/tailwind/leads.html" target="_blank" rel="noopener noreferrer">Dreams Core</a>، أُعيد تصميمها للطلبات والمتابعة في الرئيسي.</span></div>
      <button type="button" className="button button-secondary button-compact" onClick={() => setRevision(v => v + 1)}><RotateCcw size={13} /> إعادة التجارب</button></div>
    <p className="dw-muted">كل الأسماء والأرقام وهمية. تبقى هذه النماذج داخل المكتبة، ولا تستبدل شاشات الأعمال أو تغيّر بياناتها.</p>
    <div className="dw-groups" key={revision}>
      <Group title="الملخصات والفلاتر">
        <Example code="ع-01" title="شريط ملخصات العمل" note="أعداد مختصرة أعلى صفحة الطلبات أو المتابعات."><Summary /></Example>
        <Example code="ع-02" title="عنوان قسم بعداد وإجراءات" note="جرّب الإضافة لتغيير العداد المحلي فقط."><SectionHeader /></Example>
        <Example code="ع-03" title="بحث وفلاتر سريعة بنتائج" note="بحث فعلي بين أربعة سجلات وهمية دون اتصال بالخادم."><QuickFilters /></Example>
        <Example code="ع-04" title="شرائح الفلاتر النشطة" note="إزالة فلتر منفرد أو مسح جميع الفلاتر."><ActiveFilters /></Example>
        <Example code="ع-05" title="لوحة فلاتر جانبية" note="تفتح من الطرف وتعرض عدد النتائج التجريبية قبل التطبيق."><AdvancedFilters /></Example>
        <Example code="ع-06" title="نطاق تاريخ بفترات سريعة" note="فترتان جاهزتان مع من/إلى والتحقق من ترتيب التاريخ."><DateRange /></Example>
      </Group>
      <Group title="المراحل والكروت والمتابعة">
        <Example code="ع-07" title="لوحة مراحل الطلبات" note="نقل بالقائمة بدل السحب فقط، ليعمل بالهاتف ولوحة المفاتيح. العدادات والقيم تتغير محليًا." wide><OrderBoard /></Example>
        <Example code="ع-08" title="بطاقة طلب مختصرة" note="اسم وحالة ومرجع وأهم البيانات، وبقية التفاصيل عند الطلب."><CompactCard /></Example>
        <Example code="ع-09" title="معاينة سجل جانبية" note="عرض التفاصيل والتنقل بين السجلات مع بقاء القائمة في مكانها."><RecordPreview /></Example>
        <Example code="ع-10" title="اختيار أولوية نصية" note="النص وعلامة الاختيار يميزان الأولوية دون الاعتماد على اللون وحده."><Priority /></Example>
        <Example code="ع-11" title="نافذة نطاق التصدير" note="معاينة نطاق التصدير فقط؛ لا تنزيل أو طباعة فعلية."><ExportScope /></Example>
        <Example code="ع-12" title="قائمة متابعة بمسؤول وحالة" note="تحديد المراجعة يغير العداد داخل المثال ولا ينشئ مهمة."><FollowupList /></Example>
      </Group>
    </div>
  </div>;
}

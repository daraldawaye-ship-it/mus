import { useEffect, useId, useRef, useState } from "react";
import { Clock3, Search, X } from "lucide-react";
import { DemoDialog, Example, Group, SectionIntro } from "./DesignLibraryWebartShared";
import "./DesignLibrarySearch.css";

type Choice = { id: string; label: string; detail: string; group: string; aliases?: string };
const ITEMS: Choice[] = [
  { id: "1001", label: "أقراص تجريبية أ", detail: "علبة · 20 قرصًا · رمز 1001", group: "أصناف", aliases: "tablets tab 628000000001" },
  { id: "1002", label: "كبسولات تجريبية ب", detail: "علبة · 12 كبسولة · رمز 1002", group: "أصناف", aliases: "capsules cap 628000000002" },
  { id: "1003", label: "شراب تجريبي ج", detail: "زجاجة · 100 مل · رمز 1003", group: "أصناف", aliases: "syrup 628000000003" },
  { id: "1004", label: "قطرات تجريبية د", detail: "عبوة · 10 مل · رمز 1004", group: "أصناف", aliases: "drops 628000000004" },
  { id: "1005", label: "مستلزمات تجريبية هـ", detail: "كيس · 10 قطع · رمز 1005", group: "أصناف", aliases: "supplies 628000000005" },
  { id: "1006", label: "أقراص تجريبية و", detail: "علبة · 30 قرصًا · رمز 1006", group: "أصناف", aliases: "tablets 628000000006" },
];
const OTHER: Choice[] = [
  { id: "s1", label: "مورد تجريبي أ", detail: "توريد أصناف · مورد", group: "موردون" },
  { id: "s2", label: "مورد تجريبي ب", detail: "توريد مستلزمات · مورد", group: "موردون" },
  { id: "p1", label: "حركة الأصناف", detail: "صفحة توضيحية · لا تفتح بيانات حقيقية", group: "صفحات" },
  { id: "p2", label: "متابعة الطلبات", detail: "صفحة توضيحية · لا تفتح بيانات حقيقية", group: "صفحات" },
];
const ALL = [...ITEMS, ...OTHER];
const source = (slug: string) => `https://webartdevelopers.com/blog/${slug}/`;
const normalize = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[\u064b-\u065f\u0670ـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0)).trim();
const match = (item: Choice, query: string, flexible: boolean) => {
  const key = flexible ? normalize : (v: string) => v.toLowerCase().trim();
  const terms = key(query).split(/\s+/).filter(Boolean);
  const haystack = key(`${item.label} ${item.id} ${item.aliases ?? ""}`);
  return terms.every(term => haystack.includes(term));
};

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  const index = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}

function SearchBox({ label = "ابحث عن صنف تجريبي", items = ITEMS, placeholder = "اكتب جزءًا من الاسم", details = false, flexible = false, groups = false, highlight = false, delayed = false, autoFocus = false, initialQuery = "", onPick }: {
  label?: string; items?: Choice[]; placeholder?: string; details?: boolean; flexible?: boolean; groups?: boolean;
  highlight?: boolean; delayed?: boolean; autoFocus?: boolean; initialQuery?: string; onPick?: (item: Choice) => void;
}) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [settled, setSettled] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [selected, setSelected] = useState<Choice | null>(null);
  useEffect(() => {
    if (!delayed) return;
    const timer = window.setTimeout(() => setSettled(query), 350);
    return () => window.clearTimeout(timer);
  }, [query, delayed]);
  const waiting = delayed && query !== settled;
  const effective = delayed ? settled : query;
  const results = items.filter(item => match(item, effective, flexible));
  const validActive = active >= 0 && active < results.length ? active : -1;
  useEffect(() => {
    if (!open || waiting || validActive < 0 || !list.current) return;
    const option = list.current.querySelectorAll<HTMLElement>("[role=option]")[validActive];
    if (!option) return;
    const frame = list.current.getBoundingClientRect();
    const bounds = option.getBoundingClientRect();
    if (bounds.bottom > frame.bottom - 2) list.current.scrollTop += bounds.bottom - frame.bottom + 2;
    else if (bounds.top < frame.top + 2) list.current.scrollTop -= frame.top - bounds.top + 2;
  }, [open, waiting, validActive, effective]);
  const choose = (item: Choice) => {
    setQuery(item.label); setSettled(item.label); setSelected(item); setOpen(false); setActive(-1); onPick?.(item);
  };
  const clear = () => { setQuery(""); setSettled(""); setSelected(null); setActive(-1); setOpen(true); input.current?.focus(); };
  return <div className="wa-stack wa-autocomplete" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label className="wa-field" htmlFor={uid}>{label}</label>
    <div className="wa-search-input"><Search size={15} aria-hidden="true" />
      <input id={uid} ref={input} role="combobox" autoFocus={autoFocus} autoComplete="off" spellCheck={false} aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? `${uid}-list` : undefined} aria-describedby={`${uid}-help`}
        aria-activedescendant={open && !waiting && validActive >= 0 ? `${uid}-option-${results[validActive].id}` : undefined}
        value={query} placeholder={placeholder} onFocus={() => setOpen(true)}
        onChange={e => { setQuery(e.target.value); setActive(-1); setSelected(null); setOpen(true); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); setOpen(true);
            if (waiting || !results.length) return;
            setActive(e.key === "ArrowDown" ? (validActive + 1) % results.length : validActive <= 0 ? results.length - 1 : validActive - 1);
          } else if (e.key === "Enter" && open && !waiting && results.length) {
            e.preventDefault(); choose(results[validActive >= 0 ? validActive : 0]);
          } else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
        }} />
      {query && <button type="button" aria-label={`مسح ${label}`} onClick={clear}><X size={14} /></button>}
    </div>
    {open && <div ref={list} id={`${uid}-list`} className="wa-suggestions" role="listbox" aria-label={`اقتراحات ${label}`} aria-busy={waiting}>
      {waiting ? <div className="wa-search-hint">انتظار استقرار الكتابة…</div> : results.length ? results.map((item, index) => <div key={item.id} role="presentation">
        {groups && (index === 0 || results[index - 1].group !== item.group) && <div className="wa-suggestion-group" role="presentation">{item.group}</div>}
        <button type="button" role="option" id={`${uid}-option-${item.id}`} tabIndex={-1} aria-selected={validActive === index}
          className={validActive === index ? "is-active" : ""} onMouseDown={e => e.preventDefault()} onClick={() => choose(item)}>
          <span>{highlight ? <Highlight text={item.label} query={effective} /> : item.label}</span>{details && <small>{item.detail}</small>}
        </button>
      </div>) : <div className="wa-search-hint">لا توجد نتائج. جرّب اسمًا آخر أو امسح البحث.</div>}
    </div>}
    <small id={`${uid}-help`} className="wa-muted">الأسهم للتنقل، Enter للاختيار، Escape للإغلاق.</small>
    <div className="wa-muted" role="status">{selected ? `اختيار تجريبي: ${selected.label}` : waiting ? "تحديث النتائج بعد توقف الكتابة قليلًا." : `${results.length} نتائج متاحة في المثال.`}</div>
  </div>;
}

function MultiSelect() {
  const [query, setQuery] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const results = ITEMS.filter(item => match(item, query, true));
  return <div className="wa-stack">
    <label className="wa-field">ابحث ثم حدد أكثر من صنف<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="مثال: أقراص" /></label>
    <div className="wa-multi-list" role="group" aria-label="أصناف للاختيار المتعدد">{results.map(item => <label key={item.id}><input type="checkbox" checked={ids.includes(item.id)} onChange={e => setIds(old => e.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))} /><span>{item.label}</span></label>)}</div>
    {!results.length && <p className="wa-empty">لا توجد نتيجة مطابقة.</p>}
    <div className="wa-inline">{ids.map(id => <button type="button" className="wa-chip" key={id} onClick={() => setIds(old => old.filter(v => v !== id))} aria-label={`إزالة ${ITEMS.find(i => i.id === id)!.label}`}>{ITEMS.find(i => i.id === id)!.label}<X size={12} /></button>)}</div>
    <div className="wa-inline"><span className="wa-muted" role="status">المحدد: {ids.length}</span><button type="button" className="button button-ghost button-compact" disabled={!ids.length} onClick={() => setIds([])}>مسح الاختيار</button></div>
  </div>;
}
function ScopedSearch() {
  const [scope, setScope] = useState("أصناف");
  return <div className="wa-stack"><label className="wa-field">نطاق البحث<select value={scope} onChange={e => setScope(e.target.value)}>{["أصناف", "موردون", "صفحات"].map(name => <option key={name}>{name}</option>)}</select></label>
    <SearchBox key={scope} label={`بحث في ${scope}`} items={ALL.filter(i => i.group === scope)} details flexible /></div>;
}
function RecentSearch() {
  const [recent, setRecent] = useState<Choice[]>([]);
  const [last, setLast] = useState("");
  const remember = (item: Choice) => { setRecent(old => [item, ...old.filter(i => i.id !== item.id)].slice(0, 3)); setLast(item.label); };
  return <div className="wa-stack"><SearchBox onPick={remember} flexible />
    <div className="wa-inline"><Clock3 size={13} /><strong className="wa-muted">آخر 3 اختيارات</strong><button type="button" className="button button-ghost button-compact" disabled={!recent.length} onClick={() => { setRecent([]); setLast(""); }}>مسح السجل</button></div>
    <div className="wa-inline">{recent.map(item => <button type="button" className="wa-chip" key={item.id} onClick={() => remember(item)}>{item.label}</button>)}</div>
    <p className="wa-muted" role="status">{last ? `آخر اختيار: ${last}` : "اختر صنفًا لتجربة السجل المؤقت."}</p>
  </div>;
}
function HighlightedResults() {
  const [query, setQuery] = useState("تجريبية");
  const rows = ITEMS.filter(item => match(item, query, false));
  return <div className="wa-stack"><label className="wa-field">كلمة لتظليلها<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <ul className="wa-list">{rows.map(item => <li key={item.id}><span><Highlight text={item.label} query={query} /></span><span className="wa-count">{item.id}</span></li>)}</ul>
    <p className="wa-muted" role="status">{rows.length} نتائج مطابقة؛ التظليل داخل الاسم نفسه.</p></div>;
}
function EmptyResults() {
  const [query, setQuery] = useState("غير موجود");
  const results = ITEMS.filter(item => match(item, query, true));
  return <div className="wa-stack"><label className="wa-field">جرّب البحث عن اسم<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {results.length ? <ul className="wa-list">{results.map(item => <li key={item.id}>{item.label}</li>)}</ul> : <div className="wa-empty"><Search size={19} /><p>لا توجد نتيجة لـ «{query}»</p><button type="button" className="button button-secondary button-compact" onClick={() => setQuery("")}>مسح البحث وعرض الأصناف</button></div>}
    <p className="wa-muted" role="status">{results.length} نتائج تجريبية.</p></div>;
}
function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  return <div className="wa-stack"><button type="button" className="button button-secondary" onClick={() => setOpen(true)}><Search size={15} /> فتح البحث السريع</button>
    <DemoDialog open={open} onClose={() => setOpen(false)} title="بحث سريع في أمثلة المكتبة">
      {open && <SearchBox items={ALL} groups details flexible autoFocus label="ابحث في الأصناف والموردين والصفحات" onPick={item => { setSelected(item.label); setOpen(false); }} />}
    </DemoDialog><p className="wa-muted" role="status">{selected ? `تم اختيار: ${selected} داخل المثال.` : "نافذة واحدة للبحث في أكثر من نوع."}</p></div>;
}

export default function DesignLibrarySearch() {
  const [revision, setRevision] = useState(0);
  return <div className="design-webart design-webart-search">
    <SectionIntro onReset={() => setRevision(v => v + 1)}>أفكار البحث والاختيار من <a href={source("autocomplete")} target="_blank" rel="noopener noreferrer">WebArt Developers</a>، مصممة بالعربية للموقع.</SectionIntro>
    <div key={revision} className="wa-groups">
      <Group title="الاقتراحات والاختيار أثناء الكتابة">
        <Example code="ب-01" title="إكمال تلقائي بسيط" note="ابدأ بالكتابة أو افتح الحقل لرؤية الاقتراحات." source={source("autocomplete")}><SearchBox /></Example>
        <Example code="ب-02" title="اقتراحات برمز ووحدة" note="سطر مساعد يميز بين العبوات دون مغادرة البحث." source={source("bootstrap-autocomplete-dropdown")}><SearchBox details /></Example>
        <Example code="ب-03" title="بحث عربي مرن" note="جرّب «اقراص» أو «أَقْرَاص» أو tablets أو ١٠٠١؛ نفس البيانات التجريبية." source={source("autocomplete")}><SearchBox flexible details placeholder="اقراص أو tablets أو ١٠٠١" /></Example>
        <Example code="ب-04" title="نتائج مجمعة حسب النوع" note="عناوين تفصل الأصناف عن الموردين والصفحات." source={source("bootstrap-4-algolia-instant-search")}><SearchBox items={ALL} groups details flexible label="بحث في أكثر من نوع" /></Example>
      </Group>
      <Group title="الاختيار والنطاق وتوضيح المطابقة">
        <Example code="ب-05" title="اختيار متعدد قابل للبحث" note="تبقى الاختيارات عند تغيير البحث، ويمكن إزالة كل شريحة." source={source("fancy-multiple-select")}><MultiSelect /></Example>
        <Example code="ب-06" title="بحث ضمن نطاق محدد" note="تحديد نوع البيانات أولًا يحصر قائمة النتائج." source={source("dropdown-search-box")}><ScopedSearch /></Example>
        <Example code="ب-07" title="بحث برقم الصنف أو الباركود" note="جرّب 1003 أو 628000000003؛ الأرقام أمثلة فقط." source={source("autocomplete")}><SearchBox flexible details placeholder="رقم الصنف أو الباركود" label="بحث بالرقم أو الاسم" /></Example>
        <Example code="ب-08" title="تمييز الكلمات المطابقة" note="الجزء المطابق يظهر بلون واضح؛ جرّب أقراص أو تجريبية." source={source("autocomplete")}><HighlightedResults /></Example>
      </Group>
      <Group title="حالات البحث وأدواته المساعدة">
        <Example code="ب-09" title="بحث مؤجل بمؤشر انتظار" note="معاينة تأخير قصير بعد الكتابة؛ النتائج من بيانات المثال." source={source("bootstrap-4-algolia-instant-search")}><SearchBox delayed flexible details /></Example>
        <Example code="ب-10" title="سجل بحث مؤقت" note="آخر الاختيارات خلال التجربة الحالية، ويُمسح عند مغادرة القسم." source={source("bootstrap-autocomplete-dropdown")}><RecentSearch /></Example>
        <Example code="ب-11" title="بحث بلا نتائج مع استعادة" note="حالة واضحة عندما لا توجد نتيجة، وزر للعودة إلى الكل." source={source("placeholder-shown-selector")}><EmptyResults /></Example>
        <Example code="ب-12" title="نافذة بحث سريعة" note="بحث مجمع داخل نافذة، مع اختيار واضح وإغلاق بلوحة المفاتيح." source={source("dropdown-search-box")}><QuickSearch /></Example>
      </Group>
    </div>
  </div>;
}

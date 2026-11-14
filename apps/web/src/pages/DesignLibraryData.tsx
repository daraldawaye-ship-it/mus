import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ArrowDownUp, Check, ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, List, Table2 } from "lucide-react";
import { DemoDialog, Example, Group, SectionIntro } from "./DesignLibraryWebartShared";
import "./DesignLibraryData.css";

// Original, local demonstrations of table patterns; all values are fictional.
// No network requests, storage writes, or changes to operational records.
type DemoItem = { id: number; name: string; group: string; qty: number; price: number; supplier: string };
const ROWS: DemoItem[] = [
  { id: 101, name: "صنف أقراص تجريبي أ", group: "أصناف", qty: 12, price: 500, supplier: "مورد تجريبي أ" },
  { id: 102, name: "شاش تجريبي", group: "مستلزمات", qty: 24, price: 200, supplier: "مورد تجريبي ب" },
  { id: 103, name: "صنف شراب تجريبي ب", group: "أصناف", qty: 6, price: 800, supplier: "مورد تجريبي أ" },
  { id: 104, name: "قطن تجريبي", group: "مستلزمات", qty: 18, price: 300, supplier: "مورد تجريبي ج" },
  { id: 105, name: "صنف قطرات تجريبي ج", group: "أصناف", qty: 9, price: 600, supplier: "مورد تجريبي ب" },
  { id: 106, name: "قفازات تجريبية", group: "مستلزمات", qty: 30, price: 100, supplier: "مورد تجريبي ج" },
  { id: 107, name: "صنف كريم تجريبي د", group: "أصناف", qty: 4, price: 700, supplier: "مورد تجريبي أ" },
  { id: 108, name: "لاصق تجريبي", group: "مستلزمات", qty: 16, price: 150, supplier: "مورد تجريبي ب" },
];
const SMALL = ROWS.slice(0, 4);
const GROUPS = ["أصناف", "مستلزمات"];
const number = new Intl.NumberFormat("ar-YE", { maximumFractionDigits: 0 });
const source = (slug: string) => `https://webartdevelopers.com/blog/${slug}/`;
const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[أإآ]/g, "ا").replace(/[\u064B-\u065F\u0670\u0640]/g, "");

function SimpleTable({ rows, caption }: { rows: DemoItem[]; caption: string }) {
  return <div className="wa-table-scroll"><table className="wa-table" aria-label={caption}>
    <thead><tr><th scope="col">الصنف</th><th scope="col">الكمية</th><th scope="col">السعر</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{number.format(row.qty)}</td><td>{number.format(row.price)}</td></tr>)}</tbody>
  </table></div>;
}

function SortableTable() {
  type Key = "name" | "qty" | "price";
  const [sort, setSort] = useState<{ key: Key; descending: boolean }>({ key: "name", descending: false });
  const columns: { key: Key; label: string }[] = [{ key: "name", label: "الصنف" }, { key: "qty", label: "الكمية" }, { key: "price", label: "السعر" }];
  const sorted = [...SMALL].sort((a, b) => {
    const result = sort.key === "name" ? a.name.localeCompare(b.name, "ar") : a[sort.key] - b[sort.key];
    return sort.descending ? -result : result;
  });
  return <div className="wa-stack"><div className="wa-table-scroll"><table className="wa-table" aria-label="فرز أصناف تجريبية">
    <thead><tr>{columns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button type="button" className="wad-sort" onClick={() => setSort(old => ({ key: column.key, descending: old.key === column.key ? !old.descending : false }))}>
        {column.label}{sort.key === column.key ? <span aria-hidden="true">{sort.descending ? "↓" : "↑"}</span> : <ArrowDownUp size={12} aria-hidden="true" />}
      </button>
    </th>)}</tr></thead>
    <tbody>{sorted.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{number.format(row.qty)}</td><td>{number.format(row.price)}</td></tr>)}</tbody>
  </table></div><p className="wa-muted" role="status">الترتيب حسب {columns.find(column => column.key === sort.key)?.label}، {sort.descending ? "تنازليًا" : "تصاعديًا"}.</p></div>;
}

function ColumnFilters() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [min, setMin] = useState("");
  const rows = SMALL.filter(row => normalize(row.name).includes(normalize(query)) && (!group || row.group === group) && (min === "" || row.qty >= Number(min)));
  return <div className="wa-stack"><div className="wa-table-scroll"><table className="wa-table wad-filter-table" aria-label="تصفية عدة أعمدة">
    <thead><tr><th scope="col"><label className="wa-field">الصنف<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="جزء من الاسم" /></label></th>
      <th scope="col"><label className="wa-field">المجموعة<select value={group} onChange={e => setGroup(e.target.value)}><option value="">الكل</option>{GROUPS.map(value => <option key={value}>{value}</option>)}</select></label></th>
      <th scope="col"><label className="wa-field">أقل كمية<input type="number" min="0" step="1" value={min} onChange={e => setMin(e.target.value)} placeholder="0" /></label></th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.group}</td><td>{number.format(row.qty)}</td></tr>)}
      {!rows.length && <tr><td colSpan={3} className="wa-empty">لا توجد نتائج لهذه الفلاتر.</td></tr>}</tbody>
  </table></div><div className="wa-inline"><span className="wa-muted" role="status">{rows.length} من {SMALL.length} سجلات</span><button type="button" className="button button-ghost button-compact" onClick={() => { setQuery(""); setGroup(""); setMin(""); }}>مسح الفلاتر</button></div></div>;
}

function ColumnChooser() {
  const options = [{ key: "qty", label: "الكمية" }, { key: "price", label: "السعر" }, { key: "supplier", label: "المورد" }] as const;
  const [visible, setVisible] = useState<string[]>(["qty", "price"]);
  return <div className="wa-stack"><fieldset className="wad-controls"><legend>الأعمدة الظاهرة</legend><div className="wa-inline">{options.map(column => <label className="wad-check" key={column.key}>
    <input type="checkbox" checked={visible.includes(column.key)} onChange={e => setVisible(old => e.target.checked ? [...old, column.key] : old.filter(key => key !== column.key))} />{column.label}</label>)}</div></fieldset>
    <div className="wa-table-scroll"><table className="wa-table" aria-label="جدول بأعمدة مختارة"><thead><tr><th scope="col">الصنف</th>{options.filter(column => visible.includes(column.key)).map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
      <tbody>{SMALL.slice(0, 3).map(row => <tr key={row.id}><th scope="row">{row.name}</th>{options.filter(column => visible.includes(column.key)).map(column => <td key={column.key}>{typeof row[column.key] === "number" ? number.format(Number(row[column.key])) : row[column.key]}</td>)}</tr>)}</tbody>
    </table></div><p className="wa-muted">اسم الصنف يبقى ظاهرًا للتعرّف على السجل.</p></div>;
}

function BulkSelection() {
  const [selected, setSelected] = useState<number[]>([]);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => { if (all.current) all.current.indeterminate = selected.length > 0 && selected.length < SMALL.length; }, [selected]);
  const select = (id: number, checked: boolean) => setSelected(old => checked ? [...old, id] : old.filter(value => value !== id));
  return <div className="wa-stack"><div className="wad-selection-bar"><span>{selected.length} محدد</span><button type="button" className="button button-secondary button-compact" disabled={!selected.length} onClick={() => {
    setReviewed(old => [...new Set([...old, ...selected])]); setMessage(`تم تأشير ${selected.length} سجلات في المثال فقط.`); setSelected([]);
  }}><Check size={13} /> تأشير كمراجع</button></div>
    <div className="wa-table-scroll"><table className="wa-table" aria-label="تحديد عدة أصناف"><thead><tr><th scope="col"><input ref={all} type="checkbox" checked={selected.length === SMALL.length} aria-label="تحديد جميع صفوف المثال" onChange={e => setSelected(e.target.checked ? SMALL.map(row => row.id) : [])} /></th><th scope="col">الصنف</th><th scope="col">المراجعة</th></tr></thead>
      <tbody>{SMALL.map(row => <tr key={row.id} className={selected.includes(row.id) ? "wad-selected" : ""}><td><input type="checkbox" checked={selected.includes(row.id)} aria-label={`تحديد ${row.name}`} onChange={e => select(row.id, e.target.checked)} /></td><th scope="row">{row.name}</th><td>{reviewed.includes(row.id) ? "مراجع" : "غير مراجع"}</td></tr>)}</tbody>
    </table></div><p className="wa-muted" role="status">{message || "اختر صفًا أو أكثر لتجربة الإجراء الجماعي."}</p></div>;
}

function ExpandableRows() {
  const [opened, setOpened] = useState<number[]>([]);
  const prefix = useId();
  return <div className="wa-table-scroll"><table className="wa-table" aria-label="صفوف قابلة لتوسيع التفاصيل"><thead><tr><th scope="col">تفاصيل</th><th scope="col">الصنف</th><th scope="col">الكمية</th></tr></thead>
    <tbody>{SMALL.slice(0, 3).map(row => <Fragment key={row.id}><tr><td><button type="button" className="button button-ghost button-compact wad-expand" aria-expanded={opened.includes(row.id)} aria-controls={`${prefix}-${row.id}`} aria-label={`تفاصيل ${row.name}`} onClick={() => setOpened(old => old.includes(row.id) ? old.filter(id => id !== row.id) : [...old, row.id])}><ChevronDown size={15} /></button></td><th scope="row">{row.name}</th><td>{row.qty}</td></tr>
      <tr id={`${prefix}-${row.id}`} hidden={!opened.includes(row.id)}><td colSpan={3}><dl className="wad-details"><dt>المورد</dt><dd>{row.supplier}</dd><dt>المجموعة</dt><dd>{row.group}</dd><dt>سعر توضيحي</dt><dd>{number.format(row.price)} ر.ي</dd></dl></td></tr>
    </Fragment>)}</tbody></table></div>;
}

function PaginatedTable() {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(3);
  const pages = Math.ceil(ROWS.length / size);
  const start = page * size;
  return <div className="wa-stack"><div className="wa-inline"><label className="wa-field wad-size">صفوف الصفحة<select value={size} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}><option value={3}>3</option><option value={5}>5</option></select></label><span className="wa-muted">{start + 1}–{Math.min(start + size, ROWS.length)} من {ROWS.length}</span></div>
    <SimpleTable rows={ROWS.slice(start, start + size)} caption="جدول تجريبي مقسم إلى صفحات" />
    <nav className="wad-pagination" aria-label="صفحات الجدول التجريبي"><button type="button" className="button button-secondary button-compact" disabled={page === 0} onClick={() => setPage(old => old - 1)}><ChevronRight size={14} />السابق</button>
      {Array.from({ length: pages }, (_, index) => <button type="button" key={index} className={`button button-compact ${page === index ? "button-primary" : "button-secondary"}`} aria-label={`الصفحة ${index + 1}`} aria-current={page === index ? "page" : undefined} onClick={() => setPage(index)}>{index + 1}</button>)}
      <button type="button" className="button button-secondary button-compact" disabled={page === pages - 1} onClick={() => setPage(old => old + 1)}>التالي<ChevronLeft size={14} /></button></nav>
    <p className="wa-muted" role="status">الصفحة {page + 1} من {pages}</p></div>;
}

function ViewSwitcher() {
  const [cards, setCards] = useState(false);
  return <div className="wa-stack"><div className="wa-inline" role="group" aria-label="طريقة عرض الأصناف"><button type="button" className={`button button-compact ${cards ? "button-secondary" : "button-primary"}`} aria-pressed={!cards} onClick={() => setCards(false)}><List size={14} />جدول</button><button type="button" className={`button button-compact ${cards ? "button-primary" : "button-secondary"}`} aria-pressed={cards} onClick={() => setCards(true)}><LayoutGrid size={14} />بطاقات</button></div>
    {cards ? <div className="wad-cards">{SMALL.map(row => <article key={row.id}><strong>{row.name}</strong><small>{row.group}</small><dl className="wad-details"><dt>الكمية</dt><dd>{row.qty}</dd><dt>السعر</dt><dd>{number.format(row.price)}</dd></dl></article>)}</div> : <SimpleTable rows={SMALL} caption="الأصناف في عرض جدول" />}</div>;
}

function FilteredTotals() {
  const [group, setGroup] = useState("");
  const rows = SMALL.filter(row => !group || row.group === group);
  const quantity = rows.reduce((sum, row) => sum + row.qty, 0);
  const total = rows.reduce((sum, row) => sum + row.qty * row.price, 0);
  return <div className="wa-stack"><label className="wa-field">المجموعة<select value={group} onChange={e => setGroup(e.target.value)}><option value="">كل المجموعات</option>{GROUPS.map(value => <option key={value}>{value}</option>)}</select></label>
    <div className="wa-table-scroll"><table className="wa-table" aria-label="إجماليات الأصناف بعد التصفية"><thead><tr><th scope="col">الصنف</th><th scope="col">الكمية</th><th scope="col">القيمة التجريبية</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.qty}</td><td>{number.format(row.qty * row.price)}</td></tr>)}</tbody><tfoot><tr><th scope="row">الإجمالي المعروض</th><td>{number.format(quantity)}</td><td>{number.format(total)}</td></tr></tfoot></table></div>
    <p className="wa-result" role="status">{rows.length} أصناف · {number.format(quantity)} وحدة · {number.format(total)} ر.ي</p></div>;
}

function CrossHighlight() {
  const [active, setActive] = useState<{ row: number; column: number } | null>(null);
  const headings = ["الكمية", "السعر", "القيمة"];
  return <div className="wa-stack"><div className="wa-table-scroll" onMouseLeave={() => setActive(null)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(null); }}>
    <table className="wa-table wad-cross" aria-label="جدول تمييز الصف والعمود"><thead><tr><th scope="col">الصنف</th>{headings.map((heading, column) => <th key={heading} scope="col" className={active?.column === column ? "wad-axis" : ""}>{heading}</th>)}</tr></thead><tbody>{SMALL.slice(0, 3).map((item, row) => <tr key={item.id}><th scope="row" className={active?.row === row ? "wad-axis" : ""}>{item.name}</th>{[item.qty, item.price, item.qty * item.price].map((value, column) => <td key={column} className={active?.row === row && active.column === column ? "wad-intersection" : active?.row === row || active?.column === column ? "wad-axis" : ""}>
      <button type="button" onMouseEnter={() => setActive({ row, column })} onFocus={() => setActive({ row, column })} onClick={() => setActive({ row, column })} aria-label={`${item.name}، ${headings[column]}: ${value}`}>{number.format(value)}</button>
    </td>)}</tr>)}</tbody></table></div><p className="wa-muted" role="status">{active ? `${SMALL[active.row].name} — ${headings[active.column]}` : "المس قيمة، أو مرر المؤشر، أو انتقل إليها بلوحة المفاتيح."}</p></div>;
}

function ModalTable() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DemoItem | null>(null);
  const rows = SMALL.filter(row => normalize(row.name).includes(normalize(query)));
  return <div className="wa-stack"><button type="button" className="button button-secondary" onClick={() => setOpen(true)}><Table2 size={15} />اختيار من جدول</button><p className="wa-result" role="status">{picked ? `الاختيار التجريبي: ${picked.name}` : "لم يُحدد صنف بعد."}</p>
    <DemoDialog open={open} onClose={() => setOpen(false)} title="اختيار صنف تجريبي"><div className="wa-stack"><label className="wa-field">البحث في الجدول<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="اسم الصنف" /></label>
      <div className="wa-table-scroll"><table className="wa-table" aria-label="اختيار صنف من نافذة"><thead><tr><th scope="col">الصنف</th><th scope="col">الكمية</th><th scope="col">الإجراء</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.qty}</td><td><button type="button" className="button button-secondary button-compact" aria-label={`اختيار ${row.name}`} onClick={() => { setPicked(row); setOpen(false); }}>اختيار</button></td></tr>)}{!rows.length && <tr><td colSpan={3} className="wa-empty">لا يوجد صنف مطابق.</td></tr>}</tbody></table></div>
    </div></DemoDialog></div>;
}

function CompareOptions() {
  const [choice, setChoice] = useState("a");
  const options = [{ id: "a", name: "خيار تجريبي أ", price: 500, delivery: "يومان", pack: "12 وحدة" }, { id: "b", name: "خيار تجريبي ب", price: 550, delivery: "يوم واحد", pack: "12 وحدة" }];
  return <div className="wa-stack"><div className="wa-table-scroll"><table className="wa-table wad-compare" aria-label="مقارنة خيارين تجريبيين"><thead><tr><th scope="col">وجه المقارنة</th>{options.map(option => <th scope="col" key={option.id} className={choice === option.id ? "wad-selected" : ""}>{option.name}</th>)}</tr></thead><tbody>
    <tr><th scope="row">السعر التوضيحي</th>{options.map(option => <td key={option.id}>{number.format(option.price)} ر.ي</td>)}</tr><tr><th scope="row">مدة التوريد</th>{options.map(option => <td key={option.id}>{option.delivery}</td>)}</tr><tr><th scope="row">العبوة</th>{options.map(option => <td key={option.id}>{option.pack}</td>)}</tr>
    <tr><th scope="row">الاختيار</th>{options.map(option => <td key={option.id}><button type="button" className={`button button-compact ${choice === option.id ? "button-primary" : "button-secondary"}`} aria-pressed={choice === option.id} aria-label={`اختيار ${option.name}`} onClick={() => setChoice(option.id)}>{choice === option.id ? "مختار" : "اختيار"}</button></td>)}</tr>
  </tbody></table></div><p className="wa-muted" role="status">المحدد: {options.find(option => option.id === choice)?.name}. لا يُنشأ طلب شراء.</p></div>;
}

function WeeklySchedule() {
  const days = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
  const hours = ["09:00", "11:00", "14:00"];
  const [slot, setSlot] = useState<{ day: string; hour: string } | null>(null);
  return <div className="wa-stack"><div className="wa-table-scroll"><table className="wa-table wad-schedule" aria-label="جدول مواعيد أسبوعي توضيحي"><thead><tr><th scope="col">الوقت</th>{days.map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead><tbody>{hours.map((hour, hourIndex) => <tr key={hour}><th scope="row"><bdi>{hour}</bdi></th>{days.map((day, dayIndex) => {
    const occupied = (dayIndex + hourIndex) % 4 === 0;
    const selected = slot?.day === day && slot.hour === hour;
    return <td key={day}><button type="button" disabled={occupied} className={selected ? "wad-slot-selected" : ""} aria-pressed={selected} aria-label={`${day} ${hour}، ${occupied ? "مشغول" : "اختيار الموعد"}`} onClick={() => setSlot({ day, hour })}>{occupied ? "مشغول" : selected ? "مختار" : "متاح"}</button></td>;
  })}</tr>)}</tbody></table></div><div className="wa-inline"><p className="wa-result" role="status">{slot ? `${slot.day} الساعة ${slot.hour} — اختيار تجريبي` : "اختر وقتًا متاحًا لمعاينة التحديد."}</p>{slot && <button type="button" className="button button-ghost button-compact" onClick={() => setSlot(null)}>إلغاء التحديد</button>}</div></div>;
}

export default function DesignLibraryData() {
  const [revision, setRevision] = useState(0);
  return <div className="design-webart design-webart-data">
    <SectionIntro onReset={() => setRevision(value => value + 1)}>أفكار الجداول من WebArtDevelopers، بصياغة عربية تناسب الأصناف والمقارنات والمتابعة.</SectionIntro>
    <div className="wad-groups" key={revision}>
      <Group title="الفرز والتصفية والاختيار">
        <Example code="ض-01" title="جدول بفرز مباشر" source={source("excel-bootstrap-table-filter-jquery-plugin")} note="اضغط على عنوان الصنف أو الكمية أو السعر لعكس ترتيب الصفوف."><SortableTable /></Example>
        <Example code="ض-02" title="فلاتر مستقلة داخل الأعمدة" source={source("multifilter")} note="الاسم والمجموعة وأقل كمية تعمل معًا على السجلات نفسها."><ColumnFilters /></Example>
        <Example code="ض-03" title="اختيار الأعمدة الظاهرة" source={source("columnfilterwidgets")} note="أظهر الأعمدة التي تحتاجها، مع بقاء اسم الصنف."><ColumnChooser /></Example>
        <Example code="ض-04" title="تحديد جماعي وشريط إجراءات" source={source("excel-bootstrap-table-filter-jquery-plugin")} note="تحديد الكل يعرض حالة جزئية عند اختيار بعض الصفوف؛ التأشير داخل المثال فقط."><BulkSelection /></Example>
      </Group>
      <Group title="تنظيم عرض السجلات">
        <Example code="ض-05" title="تفاصيل تفتح تحت الصف" source={source("bootstrap-5-table-inside-modal-template")} note="تظهر التفاصيل الثانوية عند الطلب وتبقى المعلومات الأساسية في الجدول."><ExpandableRows /></Example>
        <Example code="ض-06" title="ترقيم صفحات فعلي" source={source("excel-bootstrap-table-filter-jquery-plugin")} note="جرّب تغيير الصفحة وحجمها؛ كل صفحة تعرض سجلات مختلفة."><PaginatedTable /></Example>
        <Example code="ض-07" title="تبديل بين الجدول والبطاقات" source={source("table-v4")} note="طريقتان لعرض البيانات نفسها حسب مساحة الشاشة وحاجة المستخدم."><ViewSwitcher /></Example>
        <Example code="ض-08" title="إجماليات مرتبطة بالتصفية" source={source("multifilter")} note="الإجمالي يطابق الصفوف المعروضة فقط، والأرقام للتوضيح."><FilteredTotals /></Example>
      </Group>
      <Group title="المقارنة والمعاينة والمواعيد">
        <Example code="ض-09" title="تمييز تقاطع الصف والعمود" source={source("table-with-vertical-horizontal-highlight")} note="مساعدة على تتبّع الأرقام باللمس أو المؤشر أو لوحة المفاتيح."><CrossHighlight /></Example>
        <Example code="ض-10" title="اختيار سجل من جدول داخل نافذة" source={source("bootstrap-5-table-inside-modal-template")} note="ابحث داخل النافذة واختر سجلًا لتعبئة نتيجة المعاينة."><ModalTable /></Example>
        <Example code="ض-11" title="جدول مقارنة خيارات" source={source("table-v4")} note="مقارنة سعر ومدة توريد وعبوة لخيارين وهميين مع اختيار واضح."><CompareOptions /></Example>
        <Example code="ض-12" title="جدول مواعيد أسبوعي" source={source("table-v4")} note="خانات متاحة ومشغولة مع اختيار مؤقت؛ لا تُنشئ حجزًا أو تذكيرًا." wide><WeeklySchedule /></Example>
      </Group>
    </div>
  </div>;
}

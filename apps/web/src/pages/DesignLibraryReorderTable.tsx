import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowDownUp, GripVertical, RotateCcw } from "lucide-react";
import "./DesignLibraryReorderTable.css";

type ColumnKey = "id" | "name" | "category" | "quantity" | "price" | "total";
type ColumnWidths = Record<ColumnKey, number>;
type DemoRow = { id: number; name: string; category: string; quantity: number; price: number; total: number };
const COLUMNS: { key: ColumnKey; label: string; width: number; minWidth: number }[] = [
  { key: "id", label: "رقم", width: 72, minWidth: 64 }, { key: "name", label: "الصنف", width: 156, minWidth: 108 },
  { key: "category", label: "الفئة", width: 112, minWidth: 88 }, { key: "quantity", label: "الكمية", width: 88, minWidth: 80 },
  { key: "price", label: "السعر", width: 116, minWidth: 88 }, { key: "total", label: "الإجمالي", width: 116, minWidth: 96 },
];
const DEFAULT_ORDER = COLUMNS.map(column => column.key);
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map(column => [column.key, column.width])) as ColumnWidths;
const MAX_COLUMN_WIDTH = 640;
const ROWS: DemoRow[] = [
  { id: 1, name: "دفتر ملاحظات", category: "دفاتر", quantity: 12, price: 800 },
  { id: 2, name: "قلم حبر", category: "أقلام", quantity: 30, price: 250 },
  { id: 3, name: "ملف مستندات", category: "ملفات", quantity: 8, price: 1200 },
  { id: 4, name: "ورق طباعة", category: "ورق", quantity: 5, price: 4500 },
  { id: 5, name: "مسطرة", category: "أدوات", quantity: 16, price: 350 },
].map(row => ({ ...row, total: row.quantity * row.price }));
const number = new Intl.NumberFormat("ar-YE");
const label = (key: ColumnKey) => COLUMNS.find(column => column.key === key)!.label;
const sameOrder = (a: ColumnKey[], b: ColumnKey[]) => a.every((key, index) => key === b[index]);
type Drag = {
  key: ColumnKey; pointerId: number; handle: HTMLButtonElement; active: boolean; valid: boolean;
  startX: number; startY: number; x: number; y: number; offset: number; width: number; next: ColumnKey[];
};
type Preview = { key: ColumnKey; left: number; top: number; width: number; lineX: number; height: number; valid: boolean };
type Resize = { key: ColumnKey; pointerId: number; handle: HTMLDivElement; startX: number; startWidth: number };

// A local design-library example: no requests, storage, or operational records.
export default function DesignLibraryReorderTable() {
  const [order, setOrder] = useState<ColumnKey[]>(() => [...DEFAULT_ORDER]);
  const [widths, setWidths] = useState<ColumnWidths>(() => ({ ...DEFAULT_WIDTHS }));
  const [resizing, setResizing] = useState<ColumnKey | null>(null);
  const [sort, setSort] = useState<{ key: ColumnKey; descending: boolean }>({ key: "id", descending: false });
  const [message, setMessage] = useState("بيانات تجريبية؛ يتحرك العمود كاملًا مع عنوانه.");
  const [preview, setPreview] = useState<Preview | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<ColumnKey, HTMLButtonElement>());
  const orderRef = useRef(order);
  const drag = useRef<Drag | null>(null);
  const resize = useRef<Resize | null>(null);
  const widthsRef = useRef(widths);
  const animation = useRef(0);
  const suppressClick = useRef(false);
  const helpId = useId();
  orderRef.current = order;
  widthsRef.current = widths;

  function changeWidth(key: ColumnKey, value: number) {
    const minimum = COLUMNS.find(column => column.key === key)!.minWidth;
    const width = Math.max(minimum, Math.min(MAX_COLUMN_WIDTH, Math.round(value)));
    if (width === widthsRef.current[key]) return;
    const next = { ...widthsRef.current, [key]: width };
    widthsRef.current = next;
    setWidths(next);
  }

  function finishResize(cancelled: boolean) {
    const current = resize.current;
    if (!current) return;
    resize.current = null;
    if (cancelled) changeWidth(current.key, current.startWidth);
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setResizing(null);
    setMessage(cancelled ? "أُلغي تغيير عرض العمود." : `عرض «${label(current.key)}»: ${widthsRef.current[current.key]} بكسل.`);
  }

  function resizeDown(event: PointerEvent<HTMLDivElement>, key: ColumnKey) {
    if (drag.current || resize.current || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    event.currentTarget.focus({ preventScroll: true });
    resize.current = { key, pointerId: event.pointerId, handle: event.currentTarget, startX: event.clientX, startWidth: widthsRef.current[key] };
    setResizing(key);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    // The separator is at inline-end (left) in RTL: moving left widens this column.
    changeWidth(current.key, current.startWidth + current.startX - event.clientX);
  }

  function resizeUp(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerId !== resize.current?.pointerId) return;
    resizeMove(event);
    finishResize(false);
  }

  function resizeKey(event: KeyboardEvent<HTMLDivElement>, key: ColumnKey) {
    if (drag.current || resize.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 24 : 8;
    const minimum = COLUMNS.find(column => column.key === key)!.minWidth;
    const value = event.key === "ArrowLeft" ? widthsRef.current[key] + step
      : event.key === "ArrowRight" ? widthsRef.current[key] - step
        : event.key === "Home" ? minimum : event.key === "End" ? MAX_COLUMN_WIDTH : null;
    if (value === null) return;
    event.preventDefault(); event.stopPropagation();
    changeWidth(key, value);
    setMessage(`عرض «${label(key)}»: ${widthsRef.current[key]} بكسل.`);
  }

  function focusColumn(key: ColumnKey, scroll = false) {
    requestAnimationFrame(() => {
      const handle = handles.current.get(key);
      if (!handle?.isConnected) return;
      handle.focus({ preventScroll: true });
      if (scroll) handle.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function moveColumn(next: ColumnKey[], key: ColumnKey) {
    if (sameOrder(next, orderRef.current)) return;
    orderRef.current = next;
    setOrder(next);
    setMessage(`نُقل «${label(key)}» إلى العمود ${next.indexOf(key) + 1} من ${next.length}.`);
    focusColumn(key);
  }

  function updateDrag() {
    const current = drag.current;
    const view = viewport.current;
    const container = stage.current;
    if (!current?.active || !view || !container) return;
    const bounds = view.getBoundingClientRect();
    const origin = container.getBoundingClientRect();
    const header = current.handle.getBoundingClientRect();
    current.valid = current.x >= bounds.left - 10 && current.x <= bounds.right + 10
      && current.y >= bounds.top - 24 && current.y <= bounds.bottom + 12;
    const remaining = orderRef.current.filter(key => key !== current.key).map(key => ({
      key, rect: handles.current.get(key)!.getBoundingClientRect(),
    }));
    // RTL reading order: centers to the right of the pointer precede the insertion.
    const index = remaining.filter(item => item.rect.left + item.rect.width / 2 > current.x).length;
    const next = remaining.map(item => item.key);
    next.splice(index, 0, current.key);
    current.next = next;
    const boundary = index === 0 ? remaining[0].rect.right
      : index === remaining.length ? remaining[remaining.length - 1].rect.left
        : (remaining[index - 1].rect.left + remaining[index].rect.right) / 2;
    setPreview({
      key: current.key, width: current.width, valid: current.valid,
      left: Math.max(0, Math.min(origin.width - current.width, current.x - current.offset - origin.left)),
      top: header.top - origin.top,
      lineX: Math.max(bounds.left + 2, Math.min(bounds.right - 2, boundary)) - origin.left,
      height: Math.max(0, Math.min(bounds.bottom, window.innerHeight) - header.top),
    });
  }

  function autoScroll() {
    const current = drag.current;
    const view = viewport.current;
    if (!current?.active || !view) return;
    const bounds = view.getBoundingClientRect();
    if (current.valid && view.scrollWidth > view.clientWidth) {
      const step = current.x < bounds.left + 36 ? -Math.min(11, (bounds.left + 36 - current.x) / 3)
        : current.x > bounds.right - 36 ? Math.min(11, (current.x - bounds.right + 36) / 3) : 0;
      if (step) { view.scrollLeft += step; updateDrag(); }
    }
    animation.current = requestAnimationFrame(autoScroll);
  }

  function finishDrag(cancelled: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(animation.current);
    if (current.active) suppressClick.current = true;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setPreview(null);
    if (!current.active) return;
    if (!cancelled && current.valid) moveColumn(current.next, current.key);
    else setMessage("أُلغي تحريك العمود.");
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, key: ColumnKey) {
    if (drag.current || resize.current || !event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = {
      key, handle: event.currentTarget, pointerId: event.pointerId, active: false, valid: true,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      offset: event.clientX - rect.left, width: rect.width, next: [...orderRef.current],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) > 6) {
      current.active = true;
      suppressClick.current = true;
      animation.current = requestAnimationFrame(autoScroll);
    }
    if (current.active) { event.preventDefault(); updateDrag(); }
  }

  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (current.active) updateDrag();
    finishDrag(false);
  }

  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, key: ColumnKey) {
    if (drag.current || resize.current) return;
    suppressClick.current = false;
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const from = orderRef.current.indexOf(key);
    const to = from + (event.key === "ArrowLeft" ? 1 : -1);
    if (to < 0 || to >= orderRef.current.length) return;
    const next = [...orderRef.current];
    next.splice(from, 1); next.splice(to, 0, key);
    moveColumn(next, key);
    focusColumn(key, true);
  }

  useEffect(() => {
    const cancel = () => { finishDrag(true); finishResize(true); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && (drag.current || resize.current)) { event.preventDefault(); cancel(); }
    };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
      cancelAnimationFrame(animation.current);
      const current = drag.current;
      drag.current = null;
      if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
      const currentResize = resize.current;
      resize.current = null;
      if (currentResize?.handle.hasPointerCapture(currentResize.pointerId)) currentResize.handle.releasePointerCapture(currentResize.pointerId);
    };
  }, []);

  const sortedRows = [...ROWS].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), "ar");
    return (sort.descending ? -result : result) || a.id - b.id;
  });

  const tableWidth = order.reduce((sum, key) => sum + widths[key], 0);
  return <div className={`wa-stack wad-reorder${preview ? " wad-reorder-active" : ""}${resizing ? " wad-reorder-resizing" : ""}`} dir="rtl">
    <div className="wad-reorder-toolbar"><span className="wa-muted" id={helpId}>اسحب العنوان للتحريك، والفاصل لتغيير العرض. انقر العنوان للفرز.</span>
      <button type="button" className="button button-ghost button-compact" disabled={sameOrder(order, DEFAULT_ORDER) && COLUMNS.every(column => widths[column.key] === column.width)} onClick={() => {
        finishDrag(true); finishResize(true); orderRef.current = [...DEFAULT_ORDER]; setOrder([...DEFAULT_ORDER]);
        widthsRef.current = { ...DEFAULT_WIDTHS }; setWidths({ ...DEFAULT_WIDTHS });
        setMessage("أُعيد ترتيب الأعمدة وعرضها الأصلي."); if (viewport.current) viewport.current.scrollLeft = 0;
      }}><RotateCcw size={12} aria-hidden="true" />إعادة الضبط</button>
    </div>
    <div ref={stage} className="wad-reorder-stage">
      <div ref={viewport} className="wa-table-scroll wad-reorder-scroll" onScroll={updateDrag} tabIndex={0} role="region" aria-label="جدول تجريبي قابل للتمرير أفقيًا">
        <table id={`${helpId}-table`} className="wa-table wad-reorder-table" style={{ width: tableWidth, minWidth: tableWidth }} aria-label="أعمدة قابلة للسحب وتغيير العرض والفرز" aria-describedby={helpId}>
          <colgroup>{order.map(key => <col key={key} style={{ width: widths[key] }} />)}</colgroup>
          <thead><tr>{order.map(key => <th key={key} scope="col" className={preview?.key === key ? "wad-reorder-source" : undefined}
            aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}>
            <button type="button" className="wad-reorder-handle" ref={node => { if (node) handles.current.set(key, node); else handles.current.delete(key); }}
              aria-describedby={helpId} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title={`${label(key)}: اسحب للتحريك أو انقر للفرز`}
              onPointerDown={event => pointerDown(event, key)} onPointerMove={pointerMove} onPointerUp={pointerUp}
              onPointerCancel={event => { if (event.pointerId === drag.current?.pointerId) finishDrag(true); }}
              onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointerId) finishDrag(true); }}
              onKeyDown={event => keyboardMove(event, key)} onDragStart={event => event.preventDefault()}
              onClick={event => {
                if (resize.current) { event.preventDefault(); return; }
                if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
                const descending = sort.key === key ? !sort.descending : false;
                setSort({ key, descending }); setMessage(`الفرز حسب ${label(key)}، ${descending ? "تنازليًا" : "تصاعديًا"}.`);
              }}>
              <GripVertical size={11} className="wad-reorder-grip" aria-hidden="true" /><span className="wad-reorder-label">{label(key)}</span>
              {sort.key === key ? <span className="wad-reorder-sort" aria-hidden="true">{sort.descending ? "↓" : "↑"}</span> : <ArrowDownUp size={11} className="wad-reorder-sort" aria-hidden="true" />}
            </button>
            <div className={`wad-reorder-resizer${resizing === key ? " is-resizing" : ""}`} role="separator" tabIndex={0}
              aria-label={`تغيير عرض عمود ${label(key)}`} aria-orientation="vertical" aria-controls={`${helpId}-table`}
              aria-valuemin={COLUMNS.find(column => column.key === key)!.minWidth} aria-valuemax={MAX_COLUMN_WIDTH}
              aria-valuenow={widths[key]} aria-valuetext={`${widths[key]} بكسل`} title={`اسحب الفاصل لتغيير عرض ${label(key)}`}
              onPointerDown={event => resizeDown(event, key)} onPointerMove={resizeMove} onPointerUp={resizeUp}
              onPointerCancel={event => { if (event.pointerId === resize.current?.pointerId) finishResize(true); }}
              onLostPointerCapture={event => { if (event.pointerId === resize.current?.pointerId) finishResize(true); }}
              onClick={event => { event.preventDefault(); event.stopPropagation(); }}
              onKeyDown={event => resizeKey(event, key)} onDragStart={event => event.preventDefault()} />
          </th>)}</tr></thead>
          <tbody>{sortedRows.map(row => <tr key={row.id}>{order.map(key => <td key={key} data-column={key}
            className={preview?.key === key ? "wad-reorder-source" : undefined}>
            {typeof row[key] === "number" ? <bdi>{number.format(Number(row[key]))}</bdi> : row[key]}
          </td>)}</tr>)}</tbody>
        </table>
      </div>
      {preview && <><div className="wad-reorder-ghost" aria-hidden="true" style={{ left: preview.left, top: preview.top, width: preview.width, opacity: preview.valid ? 1 : .5 }}>
        <GripVertical size={12} />{label(preview.key)}
      </div>{preview.valid && <div className="wad-reorder-line" aria-hidden="true" style={{ left: preview.lineX, top: preview.top, height: preview.height }} />}</>}
    </div>
    <div className="wad-reorder-footer"><span className="wa-muted" role="status" aria-live="polite" aria-atomic="true">{message}</span>
      <details className="wad-reorder-help"><summary>إظهار المزيد</summary><p>لتغيير العرض: اسحب الفاصل عند الطرف الأيسر لعنوان العمود؛ إلى اليسار للتكبير وإلى اليمين للتصغير. يبقى العرض مع العمود عند نقله.</p><p>على الهاتف: اسحب العنوان لنقله أو الفاصل لتغيير عرضه. مرّر الصفوف لرؤية بقية الأعمدة.</p><p>بلوحة المفاتيح: على العنوان استخدم <bdi>Alt + ←</bdi> أو <bdi>Alt + →</bdi> للنقل، وعلى الفاصل استخدم السهمين لتغيير العرض. يسرّع <bdi>Shift</bdi> التغيير، ويعيد <bdi>Esc</bdi> العرض السابق أثناء السحب.</p></details>
    </div>
  </div>;
}

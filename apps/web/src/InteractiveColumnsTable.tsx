import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowDownUp, GripVertical, RotateCcw } from "lucide-react";
import {useDockTableUpdate} from "./DockTableContext";
import {dockInteractiveSelector} from "./dock-table-references";
import ScrollableTableCell from "./ScrollableTableCell";
import "./InteractiveColumnsTable.css";

export type InteractiveTableColumn<Row, Key extends string = string> = {
  key: Key; label: string; width: number; cell: (row: Row) => ReactNode;
  sortable?: boolean; className?: string; header?:ReactNode; scrollText?:boolean;
};
type Props<Row, Key extends string> = {
  columns: readonly InteractiveTableColumn<Row, Key>[]; rows: readonly Row[];
  rowKey: (row: Row) => string | number; visibleColumns: readonly Key[]; storageKey: string;
  sortKey?: string; sortDirection?: "asc" | "desc"; onSort?: (key: Key) => void;
  rowClassName?: (row: Row) => string | undefined; onRowClick?: (row: Row) => void;
  ariaLabel: string; emptyMessage?: string; className?: string;
  dockRowSource?:(row:Row)=>unknown; renderRowDetails?:(row:Row)=>ReactNode; allowColumnVisibility?:boolean;
};
type Layout<Key extends string> = { order: Key[]; widths: Record<Key, number> };
type Drag<Key extends string> = {
  key: Key; pointerId: number; handle: HTMLButtonElement; active: boolean; valid: boolean;
  startX: number; startY: number; x: number; y: number; offset: number; width: number; next: Key[];
};
type Preview<Key extends string> = { key: Key; left: number; top: number; width: number; lineX: number; height: number; valid: boolean };
type Resize<Key extends string> = { key: Key; pointerId: number; handle: HTMLDivElement; startX: number; startWidth: number };
const MIN_WIDTH = 48, MAX_WIDTH = 640;
const boundedWidth = (value: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
const sameOrder = <Key extends string>(a: readonly Key[], b: readonly Key[]) => a.length === b.length && a.every((key, index) => key === b[index]);

function defaultLayout<Row, Key extends string>(columns: readonly InteractiveTableColumn<Row, Key>[]): Layout<Key> {
  return { order: columns.map(column => column.key), widths: Object.fromEntries(columns.map(column => [column.key, boundedWidth(column.width)])) as Record<Key, number> };
}

function readLayout<Row, Key extends string>(columns: readonly InteractiveTableColumn<Row, Key>[], storageKey: string): Layout<Key> {
  const fallback = defaultLayout(columns);
  if (typeof window === "undefined") return fallback;
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return fallback;
    const candidate = saved as { order?: unknown; widths?: unknown };
    const order = Array.isArray(candidate.order) ? [...new Set(candidate.order.filter((key): key is Key =>
      typeof key === "string" && fallback.order.includes(key as Key)))] : [];
    for (const key of fallback.order) if (!order.includes(key)) order.push(key);
    const savedWidths = candidate.widths && typeof candidate.widths === "object" && !Array.isArray(candidate.widths)
      ? candidate.widths as Record<string, unknown> : {};
    const widths = { ...fallback.widths };
    for (const key of fallback.order) {
      const value = savedWidths[key];
      if (typeof value === "number" && Number.isFinite(value)) widths[key] = boundedWidth(value);
    }
    return { order, widths };
  } catch { return fallback; }
}

/** A scope change remounts local layout without saving the previous user's state into the new scope. */
export default function InteractiveColumnsTable<Row, Key extends string = string>(props: Props<Row, Key>) {
  const scope = JSON.stringify([props.storageKey, props.columns.map(column => [column.key, column.width])]);
  return <InteractiveColumnsTableState key={scope} {...props} />;
}

function InteractiveColumnsTableState<Row, Key extends string>({
  columns, rows, rowKey, visibleColumns:availableColumns, storageKey, sortKey, sortDirection, onSort,
  rowClassName, onRowClick, ariaLabel, emptyMessage = "لا توجد نتائج.", className, dockRowSource,renderRowDetails,allowColumnVisibility,
}: Props<Row, Key>) {
  const updateDock=useDockTableUpdate();
  const [hidden,setHidden]=useState<Key[]>(()=>{
    try{
      const saved:unknown=JSON.parse(window.localStorage.getItem(storageKey+":hidden")??"[]");
      return Array.isArray(saved)?columns.map(column=>column.key).filter(key=>saved.includes(key)):[];
    }catch{return [];}
  });
  const effective=allowColumnVisibility?availableColumns.filter(key=>!hidden.includes(key)):availableColumns;
  const visibleColumns=effective.length?effective:availableColumns;
  const toggleVisibility=(key:Key)=>{
    const next=hidden.includes(key)?hidden.filter(item=>item!==key):[...hidden,key];
    if(!availableColumns.some(column=>!next.includes(column)))return;
    setHidden(next);
    try{window.localStorage.setItem(storageKey+":hidden",JSON.stringify(next));}catch{/* optional */}
  };
  const [layout, setLayout] = useState(() => readLayout(columns, storageKey));
  const [resizing, setResizing] = useState<Key | null>(null);
  const [preview, setPreview] = useState<Preview<Key> | null>(null);
  const [message, setMessage] = useState("");
  const viewport = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<Key, HTMLButtonElement>());
  const layoutRef = useRef(layout), visibleRef = useRef(visibleColumns), columnsRef = useRef(columns);
  const drag = useRef<Drag<Key> | null>(null), resize = useRef<Resize<Key> | null>(null);
  const animation = useRef(0), suppressClick = useRef(false);
  const helpId = useId();
  layoutRef.current = layout; visibleRef.current = visibleColumns; columnsRef.current = columns;
  const label = (key: Key) => columnsRef.current.find(column => column.key === key)?.label ?? key;

  function save(next: Layout<Key>) {
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { /* Storage restrictions do not block table interaction. */ }
  }
  function visibleOrder() { return layoutRef.current.order.filter(key => visibleRef.current.includes(key)); }
  function placeVisibleColumn(key: Key, index: number) {
    const shown = visibleOrder().filter(column => column !== key);
    shown.splice(index, 0, key);
    let position = 0;
    return layoutRef.current.order.map(column => visibleRef.current.includes(column) ? shown[position++] : column);
  }
  function changeWidth(key: Key, value: number) {
    const width = boundedWidth(value);
    if (width === layoutRef.current.widths[key]) return;
    const next = { ...layoutRef.current, widths: { ...layoutRef.current.widths, [key]: width } };
    layoutRef.current = next; setLayout(next);
  }
  function finishResize(cancelled: boolean) {
    const current = resize.current;
    if (!current) return;
    resize.current = null;
    if (cancelled) changeWidth(current.key, current.startWidth);
    else if (layoutRef.current.widths[current.key] !== current.startWidth) save(layoutRef.current);
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setResizing(null);
    setMessage(cancelled ? "أُلغي تغيير عرض العمود." : `عرض «${label(current.key)}»: ${layoutRef.current.widths[current.key]} بكسل.`);
  }
  function resizeDown(event: PointerEvent<HTMLDivElement>, key: Key) {
    if (drag.current || resize.current || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); suppressClick.current = true;
    event.currentTarget.focus({ preventScroll: true });
    resize.current = { key, pointerId: event.pointerId, handle: event.currentTarget, startX: event.clientX, startWidth: layoutRef.current.widths[key] };
    setResizing(key); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    changeWidth(current.key, current.startWidth + current.startX - event.clientX);
  }
  function resizeUp(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerId !== resize.current?.pointerId) return;
    resizeMove(event); finishResize(false);
  }
  function resizeKey(event: KeyboardEvent<HTMLDivElement>, key: Key) {
    if (drag.current || resize.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 24 : 8;
    const value = event.key === "ArrowLeft" ? layoutRef.current.widths[key] + step
      : event.key === "ArrowRight" ? layoutRef.current.widths[key] - step
        : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? MAX_WIDTH : null;
    if (value === null) return;
    event.preventDefault(); event.stopPropagation();
    changeWidth(key, value); save(layoutRef.current);
    setMessage(`عرض «${label(key)}»: ${layoutRef.current.widths[key]} بكسل.`);
  }
  function focusColumn(key: Key, scroll = false) {
    requestAnimationFrame(() => {
      const handle = handles.current.get(key);
      if (!handle?.isConnected) return;
      handle.focus({ preventScroll: true });
      if (scroll) handle.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function moveColumn(order: Key[], key: Key) {
    if (sameOrder(order, layoutRef.current.order)) return;
    const next = { ...layoutRef.current, order };
    layoutRef.current = next; setLayout(next); save(next);
    const shown = order.filter(column => visibleRef.current.includes(column));
    setMessage(`نُقل «${label(key)}» إلى العمود ${shown.indexOf(key) + 1} من ${shown.length}.`);
    focusColumn(key);
  }
  function updateDrag() {
    const current = drag.current, view = viewport.current, container = stage.current;
    if (!current?.active || !view || !container || !visibleRef.current.includes(current.key)) return;
    const bounds = view.getBoundingClientRect(), origin = container.getBoundingClientRect(), header = current.handle.getBoundingClientRect();
    current.valid = current.x >= bounds.left - 10 && current.x <= bounds.right + 10
      && current.y >= bounds.top - 24 && current.y <= bounds.bottom + 12;
    const remaining = visibleOrder().filter(key => key !== current.key).flatMap(key => {
      const handle = handles.current.get(key);
      return handle ? [{ key, rect: handle.getBoundingClientRect() }] : [];
    });
    if (!remaining.length) return;
    const index = remaining.filter(item => item.rect.left + item.rect.width / 2 > current.x).length;
    current.next = placeVisibleColumn(current.key, index);
    const boundary = index === 0 ? remaining[0].rect.right
      : index === remaining.length ? remaining[remaining.length - 1].rect.left
        : (remaining[index - 1].rect.left + remaining[index].rect.right) / 2;
    setPreview({ key: current.key, width: current.width, valid: current.valid,
      left: Math.max(0, Math.min(origin.width - current.width, current.x - current.offset - origin.left)),
      top: header.top - origin.top,
      lineX: Math.max(bounds.left + 2, Math.min(bounds.right - 2, boundary)) - origin.left,
      height: Math.max(0, Math.min(bounds.bottom, window.innerHeight) - header.top) });
  }
  function autoScroll() {
    const current = drag.current, view = viewport.current;
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
    drag.current = null; cancelAnimationFrame(animation.current);
    if (current.active) suppressClick.current = true;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setPreview(null);
    if (!current.active) return;
    if (!cancelled && current.valid) moveColumn(current.next, current.key);
    else setMessage("أُلغي تحريك العمود.");
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, key: Key) {
    if (drag.current || resize.current || !event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    if (visibleOrder().length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { key, handle: event.currentTarget, pointerId: event.pointerId, active: false, valid: true,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      offset: event.clientX - rect.left, width: rect.width, next: [...layoutRef.current.order] };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) > 6) {
      current.active = true; suppressClick.current = true;
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
  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, key: Key) {
    if (drag.current || resize.current) return;
    suppressClick.current = false;
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const shown = visibleOrder(), from = shown.indexOf(key), to = from + (event.key === "ArrowLeft" ? 1 : -1);
    if (from < 0 || to < 0 || to >= shown.length) return;
    moveColumn(placeVisibleColumn(key, to), key); focusColumn(key, true);
  }

  const visibleSignature = JSON.stringify(visibleColumns);
  useEffect(() => { finishDrag(true); finishResize(true); }, [visibleSignature]);
  useEffect(() => {
    const cancel = () => { finishDrag(true); finishResize(true); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && (drag.current || resize.current)) { event.preventDefault(); cancel(); }
    };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel); window.addEventListener("resize", cancel);
    document.addEventListener("keydown", escape); document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel);
      document.removeEventListener("keydown", escape); document.removeEventListener("visibilitychange", visibility);
      cancelAnimationFrame(animation.current);
      const current = drag.current; drag.current = null;
      if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
      const currentResize = resize.current; resize.current = null;
      if (currentResize?.handle.hasPointerCapture(currentResize.pointerId)) currentResize.handle.releasePointerCapture(currentResize.pointerId);
    };
  }, []);

  // Keep cell subtrees stable during resizing; observers handle their changed viewport widths.
  const renderedRows = useMemo(() => rows.map(row => ({ row, key: rowKey(row), className: rowClassName?.(row),
    cells: new Map(columns.map(column => [column.key, column.scrollText===false?column.cell(row):<ScrollableTableCell>{column.cell(row)}</ScrollableTableCell>])) })),
  [rows, columns, rowKey, rowClassName]);
  const columnMap = new Map(columns.map(column => [column.key, column]));
  const shown = layout.order.filter(key => visibleColumns.includes(key));
  const lastVisible = shown[shown.length - 1];
  const tableWidth = shown.reduce((sum, key) => sum + layout.widths[key], 0);
  const defaults = defaultLayout(columns);
  const isDefault = sameOrder(layout.order, defaults.order) && columns.every(column => layout.widths[column.key] === defaults.widths[column.key]);
  return <div className={`interactive-columns-table${preview ? " is-moving-column" : ""}${resizing ? " is-resizing-column" : ""}${className ? ` ${className}` : ""}`} dir="rtl">
    <div className="interactive-columns-toolbar">
      {allowColumnVisibility&&<details className="interactive-columns-help">
        <summary>الأعمدة الظاهرة</summary>
        {columns.filter(column=>availableColumns.includes(column.key)).map(column=>
          <label key={column.key} className="checkbox-field">
            <input type="checkbox" checked={visibleColumns.includes(column.key)}
              disabled={visibleColumns.length===1&&visibleColumns[0]===column.key}
              onChange={()=>toggleVisibility(column.key)} />
            {column.label}
          </label>)}
      </details>}
      <details className="interactive-columns-help"><summary>طريقة تحريك الأعمدة</summary>
        <p id={helpId}>اسحب عنوان العمود لتغيير ترتيبه، أو الفاصل الأيسر لتغيير عرضه. انقر العنوان للفرز، واسحب النص الطويل داخل الخلية لقراءة بقيته. تُحفظ العروض والترتيب على هذا الجهاز.</p>
        <p>بلوحة المفاتيح: <bdi>Alt + ← / →</bdi> على العنوان لنقله، والأسهم على الفاصل لتغيير العرض. <bdi>Esc</bdi> يلغي السحب الجاري.</p>
      </details>
      <button type="button" className="button button-secondary interactive-columns-reset" disabled={isDefault} onClick={() => {
        finishDrag(true); finishResize(true); layoutRef.current = defaults; setLayout(defaults); save(defaults);
        if (viewport.current) viewport.current.scrollLeft = 0;
        setMessage("أُعيد ترتيب الأعمدة وعروضها الأصلية.");
      }}><RotateCcw size={12} aria-hidden="true" />إعادة ترتيب وعرض الأعمدة</button>
    </div>
    <div ref={stage} className="interactive-columns-stage">
      <div ref={viewport} className="table-scroll interactive-columns-scroll" onScroll={updateDrag} tabIndex={0} role="region" aria-label={ariaLabel}>
        <table id={`${helpId}-table`} className="interactive-columns-grid" style={{ width: tableWidth, minWidth: tableWidth }} aria-label={ariaLabel} aria-describedby={helpId}>
          <colgroup>{shown.map(key => <col key={key} style={{ width: layout.widths[key] }} />)}</colgroup>
          <thead><tr>{shown.map(key => {
            const column = columnMap.get(key)!;
            const sortable = !!column.sortable && !!onSort;
            return <th key={key} scope="col" data-column={key} data-last-visible={key === lastVisible ? "true" : undefined} className={`${column.className ?? ""}${preview?.key === key ? " interactive-column-source" : ""}`}
              aria-sort={sortable ? (sortKey === key ? (sortDirection === "asc" ? "ascending" : "descending") : "none") : undefined}>
              <button type="button" className="interactive-column-handle" data-narrow={layout.widths[key] < 80 ? "true" : undefined}
                ref={node => { if (node) handles.current.set(key, node); else handles.current.delete(key); }}
                aria-describedby={helpId} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title={`${column.label}: اسحب للتحريك${sortable ? " أو انقر للفرز" : ""}`}
                onPointerDown={event => pointerDown(event, key)} onPointerMove={pointerMove} onPointerUp={pointerUp}
                onPointerCancel={event => { if (event.pointerId === drag.current?.pointerId) finishDrag(true); }}
                onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointerId) finishDrag(true); }}
                onKeyDown={event => keyboardMove(event, key)} onDragStart={event => event.preventDefault()}
                onClick={event => {
                  if (resize.current) { event.preventDefault(); return; }
                  if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
                  if (sortable) onSort?.(key);
                }}>
                <GripVertical size={11} className="interactive-column-grip" aria-hidden="true" /><span className="interactive-column-label">{column.label}</span>
                {sortable && (sortKey === key ? <span className="interactive-column-sort" aria-hidden="true">{sortDirection === "asc" ? "↑" : "↓"}</span>
                  : <ArrowDownUp size={11} className="interactive-column-sort" aria-hidden="true" />)}
              </button>
              {column.header&&<div className="interactive-column-header-extra">{column.header}</div>}
              <div className={`interactive-column-resizer${resizing === key ? " is-resizing" : ""}`} role="separator" tabIndex={0}
                aria-label={`تغيير عرض عمود ${column.label}`} aria-orientation="vertical" aria-controls={`${helpId}-table`}
                aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={layout.widths[key]} aria-valuetext={`${layout.widths[key]} بكسل`}
                title={`اسحب الفاصل لتغيير عرض ${column.label}`} onPointerDown={event => resizeDown(event, key)} onPointerMove={resizeMove} onPointerUp={resizeUp}
                onPointerCancel={event => { if (event.pointerId === resize.current?.pointerId) finishResize(true); }}
                onLostPointerCapture={event => { if (event.pointerId === resize.current?.pointerId) finishResize(true); }}
                onClick={event => { event.preventDefault(); event.stopPropagation(); }}
                onKeyDown={event => resizeKey(event, key)} onDragStart={event => event.preventDefault()} />
            </th>;
          })}</tr></thead>
          <tbody>{renderedRows.map(item => {
            const details=renderRowDetails?.(item.row);
            return <Fragment key={item.key}><tr className={item.className} onClick={event=>{
              if(updateDock&&dockRowSource&&!event.defaultPrevented&&event.detail===1&&
                  !event.altKey&&!event.ctrlKey&&!event.shiftKey&&!event.metaKey){
                const target=event.target as HTMLElement;
                const selection=target.ownerDocument.getSelection();
                if(target.closest("tr")===event.currentTarget&&!target.closest(dockInteractiveSelector)&&
                   (!selection||selection.isCollapsed||!selection.containsNode(event.currentTarget,true)))
                  updateDock(dockRowSource(item.row));
              }
              onRowClick?.(item.row);
            }}>
            {/* Keep hidden editors mounted so an in-flight debounced edit is not cancelled. */}
            {layout.order.map(key => <td key={key} data-column={key} data-last-visible={key === lastVisible ? "true" : undefined}
              style={visibleColumns.includes(key) ? undefined : { display: "none" }}
              className={`${columnMap.get(key)?.className ?? ""}${preview?.key === key ? " interactive-column-source" : ""}`}>{item.cells.get(key)}</td>)}
          </tr>{details!=null&&<tr className="interactive-column-row-details"><td colSpan={Math.max(1,shown.length)}>{details}</td></tr>}</Fragment>;
          })}{!rows.length && <tr><td colSpan={Math.max(1, shown.length)}>{emptyMessage}</td></tr>}</tbody>
        </table>
      </div>
      {preview && <><div className="interactive-column-ghost" aria-hidden="true" style={{ left: preview.left, top: preview.top, width: preview.width, opacity: preview.valid ? 1 : .5 }}><GripVertical size={12} />{label(preview.key)}</div>
        {preview.valid && <div className="interactive-column-insertion" aria-hidden="true" style={{ left: preview.lineX, top: preview.top, height: preview.height }} />}</>}
    </div>
    <span className="interactive-columns-status" role="status" aria-live="polite" aria-atomic="true">{message}</span>
  </div>;
}

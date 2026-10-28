import {
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, X } from "lucide-react";
import { actionColumnsFirst } from "./table-column-order";
import { Link } from "react-router-dom";
import { HeaderActionsOverflow } from "./SalesHeaderActionsDropdown";
import { formatMoney } from "./format-money";

export function Button({
  variant = "primary",
  size = "normal",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "compact" | "normal";
}) {
  return (
    <button
      {...props}
      type={type}
      className={`button button-${variant} button-${size} ${className}`}
    />
  );
}
export function Card({
  title,
  description,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || description) && (
        <div className="card-heading">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
/** Only plain action links/buttons are grouped. Search fields, filters,
 * forms and specialized toolbars retain their own original layout. */
function flattenHeaderActionNodes(nodes: ReactNode): ReactNode[] {
  if (nodes === null || nodes === undefined || typeof nodes === "boolean") return [];
  if (Array.isArray(nodes)) return nodes.flatMap(flattenHeaderActionNodes);
  if (isValidElement<{children?:ReactNode}>(nodes) && nodes.type === Fragment)
    return flattenHeaderActionNodes(nodes.props.children);
  return [nodes];
}
function isSimpleHeaderAction(value: ReactNode): boolean {
  return isValidElement(value) &&
    (value.type === Button || value.type === Link ||
      value.type === "a" || value.type === "button");
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const actionNodes=flattenHeaderActionNodes(actions);
  const useActionsMenu=actionNodes.length>1 && actionNodes.every(isSimpleHeaderAction);
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">
        {useActionsMenu?<HeaderActionsOverflow actions={actionNodes}/>:actions}
      </div>}
    </div>
  );
}
export function Field({
  label,
  hint,
  error,
  id,
  className = "",
  money = false,
  value,
  onFocus,
  onBlur,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  /** Group displayed amounts; keep the controlled value unmodified for saving. */
  money?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  // A compact label stays above a value, native date control or placeholder.
  const hasValue = String(value ?? props.defaultValue ?? "").length > 0;
  const labelRaised = hasValue || !!props.placeholder || !!props.readOnly ||
    ["date", "datetime-local", "time", "month", "week", "color"].includes(props.type ?? "");
  const [focused, setFocused] = useState(false);
  const displayed = money && value !== null && value !== undefined &&
    (!focused || props.readOnly)
    ? formatMoney(String(value))
    : value;
  return (
    <div className={`field floating-ready ${className}`} data-label-raised={labelRaised ? "true" : "false"}>
      <label htmlFor={fieldId}>{label}</label>
      <input
        {...props}
        id={fieldId}
        value={displayed}
        onFocus={(event) => {
          if (money) setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          if (money) setFocused(false);
          onBlur?.(event);
        }}
        aria-invalid={!!error || undefined}
        aria-describedby={hint || error ? `${fieldId}-hint` : undefined}
      />
      {(hint || error) && (
        <small id={`${fieldId}-hint`} className={error ? "text-error" : ""}>
          {error ?? hint}
        </small>
      )}
    </div>
  );
}
export function Select({
  label,
  id,
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const generated = useId();
  const fieldId = id ?? generated;
  const control = (
    <select {...props} id={fieldId} className={label ? "" : className}>
      {children}
    </select>
  );
  return label ? (
    <div className={`field floating-ready ${className}`} data-label-raised="true">
      <label htmlFor={fieldId}>{label}</label>
      {control}
    </div>
  ) : (
    control
  );
}
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  children: ReactNode;
}) {
  return (
    <div
      className={`notice notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    previous.current = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous.current?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      className={`dialog ${className}`}
      aria-labelledby={title ? heading : undefined}
      aria-label={title ? undefined : "نافذة اختيار الطبيب والعميل"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-heading">
        {title && <h2 id={heading}>{title}</h2>}
        <Button variant="ghost" aria-label="إغلاق النافذة" onClick={onClose}>
          <X size={17} />
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}
export function ValueCell({
  children,
  value,
}: {
  children: ReactNode;
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const full =
    value ??
    (typeof children === "string" || typeof children === "number"
      ? String(children)
      : "");
  return (
    <>
      <button
        className="table-value"
        type="button"
        title={full}
        aria-label={`عرض القيمة كاملة: ${full}`}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">{children}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="القيمة الكاملة">
        <p className="full-value">{full}</p>
      </Dialog>
    </>
  );
}
interface TableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  loading?: boolean;
  selectionMode?: "single" | "multi" | "os";
  onSelectionChange?: (ids: string[]) => void;
  /** Notify the caller of the actual record clicked, including row actions. */
  onRowInteract?: (row: T) => void;
  getRowId?: (row: T) => string;
  ariaLabel?: string;
}
export function DataTable<T>({
  columns,
  data,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sorting,
  onSortingChange,
  loading,
  selectionMode = "multi",
  onSelectionChange,
  onRowInteract,
  getRowId,
  ariaLabel = "جدول البيانات",
}: TableProps<T>) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const anchor = useRef<string | null>(null);
  const [fullValue, setFullValue] = useState<string | null>(null);
  const table = useReactTable({
    columns: actionColumnsFirst(columns),
    data,
    state: { sorting },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    getRowId: getRowId ?? ((row) => String((row as { id: unknown }).id)),
  });
  const rows = table.getRowModel().rows;
  const allPage = rows.length > 0 && rows.every((row) => selected[row.id]);
  const somePage = rows.some((row) => selected[row.id]);
  const update = (next: Record<string, boolean>) => {
    setSelected(next);
    onSelectionChange?.(Object.keys(next).filter((id) => next[id]));
  };
  const choose = (
    id: string,
    event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    checkbox = false,
  ) => {
    let next = { ...selected };
    if (selectionMode === "single") next = { [id]: !selected[id] };
    else if (selectionMode === "os" && event?.shiftKey && anchor.current) {
      const start = rows.findIndex((row) => row.id === anchor.current);
      const end = rows.findIndex((row) => row.id === id);
      if (start >= 0)
        rows
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .forEach((row) => {
            next[row.id] = true;
          });
      else next[id] = true;
    } else if (
      selectionMode === "os" &&
      !checkbox &&
      !event?.ctrlKey &&
      !event?.metaKey
    )
      next = { [id]: true };
    else next[id] = !selected[id];
    anchor.current = id;
    update(next);
  };
  const sortColumn = (id: string, multi: boolean) => {
    const index = sorting.findIndex((item) => item.id === id);
    const item = sorting[index];
    const nextItem = !item
      ? { id, desc: false }
      : !item.desc
        ? { id, desc: true }
        : null;
    if (!multi) onSortingChange(nextItem ? [nextItem] : []);
    else {
      const next = [...sorting];
      if (index < 0 && nextItem) next.push(nextItem);
      else if (nextItem) next[index] = nextItem;
      else next.splice(index, 1);
      onSortingChange(next);
    }
  };
  return (
    <div
      className="data-table"
      data-selected-ids={Object.keys(selected)
        .filter((id) => selected[id])
        .join(",")}
      data-selection-mode={selectionMode}
      aria-busy={loading || undefined}
    >
      <div className="table-tools">
        <span>
          {total.toLocaleString("ar")} سجل{" "}
          <span className="muted">
            ·{" "}
            {Object.values(selected)
              .filter(Boolean)
              .length.toLocaleString("ar")}{" "}
            محدد
          </span>
        </span>
        <span className="muted">Shift لإضافة ترتيب آخر</span>
      </div>
      <div className="table-scroll">
        <table
          aria-label={ariaLabel}
          style={{ minWidth: `${table.getTotalSize() + 33}px` }}
        >
          <colgroup>
            <col style={{ width: 33 }} />
            {table.getAllLeafColumns().map((column) => (
              <col key={column.id} style={{ width: column.getSize() }} />
            ))}
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th className="selection-cell">
                  {selectionMode !== "single" && (
                    <input
                      type="checkbox"
                      aria-label="اختيار كل سجلات الصفحة الحالية فقط"
                      checked={allPage}
                      ref={(element) => {
                        if (element)
                          element.indeterminate = somePage && !allPage;
                      }}
                      onChange={() => {
                        const next = { ...selected };
                        rows.forEach((row) => {
                          next[row.id] = !allPage;
                        });
                        update(next);
                      }}
                    />
                  )}
                </th>
                {group.headers.map((header) => {
                  const priority = sorting.findIndex(
                    (item) => item.id === header.column.id,
                  );
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        priority === 0
                          ? sorting[priority].desc
                            ? "descending"
                            : "ascending"
                          : undefined
                      }
                      data-column-id={header.column.id}
                      data-sort-priority={
                        priority >= 0 ? priority + 1 : undefined
                      }
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          className="sort-button"
                          onClick={(event) =>
                            sortColumn(header.column.id, event.shiftKey)
                          }
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {priority >= 0 && (
                            <span className="sort-indicator">
                              {sorting[priority].desc ? (
                                <ArrowDown size={12} />
                              ) : (
                                <ArrowUp size={12} />
                              )}
                              <small>{priority + 1}</small>
                            </span>
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-row-id={row.id}
                aria-selected={!!selected[row.id]}
                onClickCapture={() => onRowInteract?.(row.original)}
                onClick={(event) => {
                  if (
                    !(event.target as HTMLElement).closest(
                      "button,input,select,a",
                    )
                  )
                    choose(row.id, event);
                }}
              >
                <td className="selection-cell">
                  <input
                    type={selectionMode === "single" ? "radio" : "checkbox"}
                    aria-label={`اختيار السجل ${row.id}`}
                    checked={!!selected[row.id]}
                    onChange={(event) => {
                      const native = event.nativeEvent as MouseEvent;
                      choose(
                        row.id,
                        {
                          shiftKey: native.shiftKey ?? false,
                          ctrlKey: native.ctrlKey ?? false,
                          metaKey: native.metaKey ?? false,
                        },
                        true,
                      );
                    }}
                  />
                </td>
                {row.getVisibleCells().map((cell) => {
                  const original = columns.find(
                    (column) =>
                      ("id" in column && column.id === cell.column.id) ||
                      ("accessorKey" in column &&
                        column.accessorKey === cell.column.id),
                  );
                  const raw = cell.getValue();
                  const rendered =
                    !original?.cell &&
                    (typeof raw === "string" || typeof raw === "number")
                      ? raw
                      : flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        );
                  const simple =
                    typeof rendered === "string" ||
                    typeof rendered === "number";
                  return (
                    <td key={cell.id} data-cell-id={cell.column.id}>
                      {simple ? (
                        <button
                          type="button"
                          className="table-value"
                          title={String(rendered)}
                          onClick={() => setFullValue(String(rendered))}
                        >
                          {rendered}
                        </button>
                      ) : (
                        <div className="cell-content">{rendered}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="table-empty">
            {loading ? "جارٍ تحميل السجلات…" : "لا توجد سجلات تطابق البحث"}
          </div>
        )}
      </div>
      <div className="pagination">
        <label>
          سجلات الصفحة{" "}
          <Select
            aria-label="عدد سجلات الصفحة"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {[10, 20, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>
        <span>
          صفحة {page.toLocaleString("ar")} من{" "}
          {Math.max(1, Math.ceil(total / pageSize)).toLocaleString("ar")}
        </span>
        <div>
          <Button
            variant="secondary"
            size="compact"
            aria-label="الصفحة السابقة"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronRight size={16} />
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label="الصفحة التالية"
            disabled={page * pageSize >= total || loading}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronLeft size={16} />
          </Button>
        </div>
      </div>
      <Dialog
        open={fullValue !== null}
        onClose={() => setFullValue(null)}
        title="القيمة الكاملة"
      >
        <p className="full-value">{fullValue}</p>
      </Dialog>
    </div>
  );
}

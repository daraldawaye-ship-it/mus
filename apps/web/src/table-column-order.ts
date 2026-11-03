import type { ColumnDef } from "@tanstack/react-table";

/** Keep row operations at the beginning of the data columns in RTL lists. */
function isRowAction<T>(column: ColumnDef<T, unknown>): boolean {
  if (!("id" in column) || typeof column.id !== "string") return false;
  if (["actions", "open", "links"].includes(column.id)) return true;
  // A page-directory "edit" permission column is not a row action.
  return column.id === "edit" && column.header === "الإجراءات";
}

export function actionColumnsFirst<T>(
  columns: ColumnDef<T, unknown>[],
): ColumnDef<T, unknown>[] {
  const actions = columns.filter(isRowAction);
  if (!actions.length || columns.slice(0, actions.length).every((column, index) => column === actions[index]))
    return columns;
  return [...actions, ...columns.filter((column) => !isRowAction(column))];
}

/** Presentation-only order for the sales invoice list; purchases remain unchanged. */
export function arrangeInvoiceListColumns<T>(
  kind: "sale" | "purchase", columns: ColumnDef<T, unknown>[],
): ColumnDef<T, unknown>[] {
  if (kind !== "sale") return columns;
  const key = (column: ColumnDef<T, unknown>): string =>
    "id" in column && typeof column.id === "string" ? column.id :
      "accessorKey" in column && typeof column.accessorKey === "string" ? column.accessorKey : "";
  const first = ["open", "print", "total", "counterpartyAccountName", "documentDate"];
  const visible = columns.filter(column => !["return", "currencyCode"].includes(key(column)));
  return [
    ...first.flatMap(id => visible.filter(column => key(column) === id)),
    ...visible.filter(column => !first.includes(key(column))),
  ];
}

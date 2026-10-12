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

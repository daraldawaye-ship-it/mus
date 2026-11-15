import type { PageEntry } from "../../../../packages/contracts/src/index.ts";
import { pagePermissionAliases, type RuleEffect } from "./permission-rules.ts";

type NoteAccess = { sale: boolean; purchase: boolean; operation: boolean };

export function stockMovementNotesAccess(
  entries: readonly Pick<PageEntry, "key" | "actionAccess">[],
  explicitEffects: ReadonlyMap<string, RuleEffect>,
  commerceView: boolean,
): NoteAccess {
  const canView = (key: string) =>
    entries.some(page => page.key === key && page.actionAccess.view) &&
    pagePermissionAliases(key, "view").every(alias => explicitEffects.get(alias) !== "deny");
  const invoice = commerceView && canView("company.invoice");
  return {
    sale: invoice && canView("company.sales"),
    purchase: invoice && canView("company.purchases"),
    operation: canView("company.stock-operations"),
  };
}

/** Only fixed SQL literals depend on authorization, never user-supplied text. */
export function stockMovementNotesSql(access: NoteAccess) {
  const expressions: string[] = [];
  if (access.sale) expressions.push("WHEN doctor_invoice.kind='sale' THEN doctor_invoice.description");
  if (access.purchase) expressions.push("WHEN doctor_invoice.kind='purchase' THEN doctor_invoice.description");
  if (access.operation) expressions.push("WHEN note_operation.id IS NOT NULL THEN note_operation.description");
  return {
    join: access.operation
      ? " LEFT JOIN stock_operations note_operation ON note_operation.company_id=m.company_id AND note_operation.id=m.operation_id"
      : "",
    value: expressions.length ? `NULLIF(CASE ${expressions.join(" ")} END,'')` : "NULL::text",
    searchable: expressions.length > 0,
  };
}

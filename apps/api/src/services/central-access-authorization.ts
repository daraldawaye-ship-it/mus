import type { Database } from "../db.ts";
import { medicalPaymentSummaryPositions, type PageAction } from "../../../../packages/contracts/src/pages.ts";

/** Company-scoped authoritative position gates for page visibility.
 * An empty list means the platform owner alone. No job-position selection
 * replaces domain permissions for creating, posting, reversing or editing data.
 */
export type CentralPagePolicy = {
  viewPositions: string[];
  editPositions: string[];
};
export async function centralResourcePolicies(
  db: Database, companyId: number, keys?: readonly string[],
): Promise<Map<string, CentralPagePolicy>> {
  const rows = await db.query(
    `SELECT resource_key AS key, view_positions AS "viewPositions",
       edit_positions AS "editPositions" FROM central_access_policies
     WHERE company_id=$1
       AND ($2::text[] IS NULL OR resource_key=ANY($2::text[]))`,
    [companyId, keys ?? null],
  );
  return new Map(rows.rows.map(row=>[String(row.key), {
    viewPositions: row.viewPositions as string[],
    editPositions: row.editPositions as string[],
  }]));
}
export function centralDefaultPageViewPositions(pageKey: string): ("sales" | "cashier")[] {
  return pageKey === "company.item-return-requests" || pageKey === "company.medical-payment-summary"
    ? [...medicalPaymentSummaryPositions] : [];
}
export function centralPageAllows(
  policies: ReadonlyMap<string, CentralPagePolicy>,
  pageKey: string, action: PageAction,
  isOwner: boolean, positions: readonly string[],
): boolean {
  if (isOwner) return true;
  const policy = policies.get("page:"+pageKey);
  // A stored policy, including an empty list, overrides the new page's default.
  const allowed = action==="view" || action==="print"
    ? policy?.viewPositions ?? centralDefaultPageViewPositions(pageKey)
    : policy?.editPositions ?? [];
  // The generic "موظف" selection on company chat means every active
  // company member. All callers validate company membership before reaching
  // this page decision; it is not a public or cross-company grant.
  if (pageKey==="company.chat" && allowed.includes("employee")) return true;
  return allowed.some(key=>positions.includes(key));
}

// Limit page decisions to the dedicated page:* namespace.
export async function centralPagePolicies(
  db: Database, companyId: number, keys?: readonly string[],
): Promise<Map<string, CentralPagePolicy>> {
  if (keys) return centralResourcePolicies(db, companyId, keys);
  const policies = await centralResourcePolicies(db, companyId);
  return new Map([...policies].filter(([key]) => key.startsWith("page:")));
}
/** Read/edit policy for a central resource (control:*, field:*, button:*). */
export function centralResourceAllows(
  policies: ReadonlyMap<string, CentralPagePolicy>,
  resourceKey: string, action: "view"|"edit",
  isOwner: boolean, positions: readonly string[],
): boolean {
  if (isOwner) return true;
  const policy = policies.get(resourceKey);
  if (!policy) return false;
  const selected = action === "view" ? policy.viewPositions : policy.editPositions;
  return selected.some(key => positions.includes(key));
}

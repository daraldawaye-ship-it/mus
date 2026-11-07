import type { Database } from "../db.ts";
import type { PageAction } from "../../../../packages/contracts/src/pages.ts";

/** Company-scoped authoritative position gates for page visibility.
 * An empty list means the platform owner alone. No job-position selection
 * replaces domain permissions for creating, posting, reversing or editing data.
 */
export type CentralPagePolicy = {
  viewPositions: string[];
  editPositions: string[];
};
export async function centralPagePolicies(
  db: Database, companyId: number, keys?: readonly string[],
): Promise<Map<string, CentralPagePolicy>> {
  const rows = await db.query(
    `SELECT resource_key AS key, view_positions AS "viewPositions",
       edit_positions AS "editPositions" FROM central_access_policies
     WHERE company_id=$1 AND resource_key LIKE 'page:%'
       AND ($2::text[] IS NULL OR resource_key=ANY($2::text[]))`,
    [companyId, keys ?? null],
  );
  return new Map(rows.rows.map(row=>[String(row.key), {
    viewPositions: row.viewPositions as string[],
    editPositions: row.editPositions as string[],
  }]));
}
export function centralPageAllows(
  policies: ReadonlyMap<string, CentralPagePolicy>,
  pageKey: string, action: PageAction,
  isOwner: boolean, positions: readonly string[],
): boolean {
  if (isOwner) return true;
  const policy = policies.get("page:"+pageKey);
  // Central page list is a deny-by-default authorization surface.
  if (!policy) return false;
  const allowed = action==="view" || action==="print"
    ? policy.viewPositions : policy.editPositions;
  return allowed.some(key=>positions.includes(key));
}

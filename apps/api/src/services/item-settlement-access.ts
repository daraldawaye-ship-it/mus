import type { Database } from "../db.ts";
import type { User } from "../../../../packages/contracts/src/index.ts";
import {
  centralPageAllows,
  centralResourceAllows,
  centralResourcePolicies,
} from "./central-access-authorization.ts";

export type ItemSettlementStampAccess = { display: boolean; approval: boolean };

const displayKey = "button:items.settlement-display";
const approvalKey = "button:items.settlement-approval";

/** Independent company-scoped action authorization; generic items.manage
 * never silently grants display or approval. The owner is the default.
 * Item viewing and page-enabled guards are checked by the calling route.
 */
export async function itemSettlementStampAccess(
  db: Database, user: User, companyId: number,
): Promise<ItemSettlementStampAccess> {
  if (user.owner) return { display: true, approval: true };
  const employee = await db.query(
    "SELECT position_keys FROM employees WHERE company_id=$1 AND user_id=$2 AND active=true",
    [companyId,user.id],
  );
  if (!employee.rows[0]) return { display: false, approval: false };
  const positions: string[] = employee.rows[0].position_keys ?? [];
  const policies = await centralResourcePolicies(db,companyId,[
    "page:company.items","page:company.item-card",displayKey,approvalKey,
  ]);
  const canSeeCard = ["company.items","company.item-card"].every(pageKey =>
    centralPageAllows(policies,pageKey,"view",false,positions));
  return {
    display: canSeeCard && centralResourceAllows(policies,displayKey,"edit",false,positions),
    approval: canSeeCard && centralResourceAllows(policies,approvalKey,"edit",false,positions),
  };
}

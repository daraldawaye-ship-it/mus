import type { Pool, PoolClient } from "pg";
import type { PageEntry, User } from "../../../../packages/contracts/src/index.ts";
import { transaction } from "../db.ts";
import { userDTO } from "../repositories/models.ts";
import { directoryEntries } from "./pages.ts";

/** Requested specifically for Dar Aldawa, company 2. Never grant access
 * via shortcut defaults; use exact existing page/action permissions.
 */
export const COMPANY2_INVOICE_KEYS = [
  "company.sale-new", "company.purchase-new",
] as const;
type InvoiceKey = typeof COMPANY2_INVOICE_KEYS[number];

export function authorizedInvoiceShortcuts(entries: readonly PageEntry[]): InvoiceKey[] {
  const pages = new Map(entries.map(entry => [entry.key, entry]));
  const invoice = pages.get("company.invoice");
  if (!invoice?.enabled || !invoice.actionAccess.view) return [];
  return COMPANY2_INVOICE_KEYS.filter(key => {
    const entry = pages.get(key);
    const parent = pages.get(key === "company.sale-new"
      ? "company.sales" : "company.purchases");
    return !!entry?.enabled && !!entry.href && !entry.record &&
      !!entry.actionAccess.view && !!entry.actionAccess.create &&
      !!parent?.enabled && !!parent.actionAccess.view;
  });
}
type ShortcutsRow = { page_keys: string[]; invoice_defaults_seen: string[] };

/** Persist authorized defaults for existing employee accounts and new eligible
 * employees. A key is initialized at most once: personal removal remains
 * respected even after a reload, reconnect or future server restart.
 */
export async function ensureCompany2InvoiceShortcuts(
  client: PoolClient, user: User, entries: readonly PageEntry[],
): Promise<{pageKeys:string[]; added:InvoiceKey[]}> {
  const eligible = authorizedInvoiceShortcuts(entries);
  if (eligible.length) {
    await client.query(
      `INSERT INTO user_page_shortcuts(user_id,scope_company_id,page_keys)
       VALUES($1,2,ARRAY[]::text[]) ON CONFLICT(user_id,scope_company_id) DO NOTHING`,
      [user.id],
    );
  }
  const result = await client.query<ShortcutsRow>(
    `SELECT page_keys,invoice_defaults_seen FROM user_page_shortcuts
     WHERE user_id=$1 AND scope_company_id=2 FOR UPDATE`,
    [user.id],
  );
  const previous = result.rows[0];
  if (!previous) return {pageKeys:[],added:[]};
  const seen = previous.invoice_defaults_seen ?? [];
  const unseen = eligible.filter(key => !seen.includes(key));
  if (!unseen.length) return {pageKeys:previous.page_keys,added:[]};
  const updatedKeys = [...previous.page_keys];
  const added:InvoiceKey[] = [];
  for (const key of unseen) if (!updatedKeys.includes(key)) {
    updatedKeys.push(key);
    added.push(key);
  }
  await client.query(
    `UPDATE user_page_shortcuts SET
       page_keys=$3::text[],invoice_defaults_seen=$4::text[],
       updated_at=clock_timestamp()
     WHERE user_id=$1 AND scope_company_id=$2`,
    [user.id,2,updatedKeys,[...seen,...unseen]],
  );
  return {pageKeys:updatedKeys,added};
}

/** Do not defer changes until an employee gets created or signs in:
 * reconcile every existing active employee against real page grants at deploy.
 */
export async function provisionExistingDarAldawaInvoiceShortcuts(pool: Pool) {
  const rows = await pool.query(
    `SELECT u.* FROM users u WHERE NOT u.archived AND NOT u.suspended
     AND EXISTS(SELECT 1 FROM employees e
                WHERE e.company_id=2 AND e.user_id=u.id AND e.active)
     ORDER BY u.id`,
  );
  let examined=0, eligibleUsers=0, updatedUsers=0, saleAdded=0, purchaseAdded=0, failed=0;
  for (const record of rows.rows) {
    try {
      const user = userDTO(record);
      const outcome = await transaction(pool, async client => {
        const entries = await directoryEntries(client,user,2);
        const eligible=authorizedInvoiceShortcuts(entries);
        const result=await ensureCompany2InvoiceShortcuts(client,user,entries);
        return {eligible:eligible.length, added:result.added};
      });
      examined++;
      if (outcome.eligible) eligibleUsers++;
      if (outcome.added.length) updatedUsers++;
      if (outcome.added.includes("company.sale-new")) saleAdded++;
      if (outcome.added.includes("company.purchase-new")) purchaseAdded++;
    } catch (error) {
      failed++;
      console.error("COMPANY2_INVOICE_SHORTCUT_ACCOUNT_FAILED",{
        accountId:record.id,
        code:error && typeof error==="object" && "code" in error
          ? String(error.code) : "shortcut_provision_failed",
      });
    }
  }
  console.info("COMPANY2_INVOICE_SHORTCUTS_RECONCILED",
    JSON.stringify({examined,eligibleUsers,updatedUsers,saleAdded,purchaseAdded,failed}));
  return {examined,eligibleUsers,updatedUsers,saleAdded,purchaseAdded,failed};
}

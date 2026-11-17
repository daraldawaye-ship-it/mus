import type { PoolClient } from "pg";
import { effectiveTemplate, emitNotification } from "./notifications.ts";

export type GroupedStockAlertCode = "ITEM_ORDER_LEVEL" | "ITEM_EXPIRED" | "ITEM_EXPIRING_30";
const expiryTypes = ["ITEM_EXPIRED", "ITEM_EXPIRING_30"] as const;

/** The card's "do not repeat within N hours" controls BOTH the recheck and
 * notification interval for aggregate inventory monitors.
 * When blank, a conservative one-hour cadence applies to these types only.
 * The existing company worker transaction/advisory lock serializes runs.
 */
export function stockAlertCheckHours(hours: number | null | undefined): number {
  return Number.isSafeInteger(hours) && (hours ?? 0) >= 1 ? hours! : 1;
}

async function dueToScan(client: PoolClient, companyId: number,
  code: GroupedStockAlertCode, hours: number): Promise<Date | null> {
  const response = await client.query<{ checked_at: Date }>(
    `INSERT INTO stock_alert_group_scans(company_id,code,checked_at)
       VALUES($1,$2,clock_timestamp())
       ON CONFLICT(company_id,code) DO UPDATE
         SET checked_at=EXCLUDED.checked_at
         WHERE stock_alert_group_scans.checked_at <=
           EXCLUDED.checked_at - $3::integer * interval '1 hour'
       RETURNING checked_at`,
    [companyId, code, hours],
  );
  return response.rows[0]?.checked_at ?? null;
}

async function orderShortages(client: PoolClient, companyId: number) {
  // Keep historical incident state accurate for existing dashboards while
  // issuing ONE company-wide alert rather than one notification per item.
  const predicate = `i.active AND i.order_alert_quantity IS NOT NULL
    AND COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
       <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric`;
  await client.query(
    `UPDATE item_order_notification_incidents incident
       SET active=false,updated_at=clock_timestamp()
       WHERE company_id=$1 AND active AND NOT EXISTS (
         SELECT 1 FROM items i LEFT JOIN item_statistics s
           ON s.company_id=i.company_id AND s.item_id=i.id
         WHERE i.company_id=incident.company_id AND i.id=incident.item_id
           AND ${predicate}
       )`, [companyId],
  );
  await client.query(
    `INSERT INTO item_order_notification_incidents
       (company_id,item_id,episode,active)
       SELECT i.company_id,i.id,1,true FROM items i
       LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
       WHERE i.company_id=$1 AND ${predicate}
       ON CONFLICT(company_id,item_id) DO UPDATE SET
         episode=CASE WHEN item_order_notification_incidents.active
           THEN item_order_notification_incidents.episode
           ELSE item_order_notification_incidents.episode+1 END,
         legacy_suppressed=false,active=true,updated_at=clock_timestamp()`,
    [companyId],
  );
  const count = await client.query<{ total: number }>(
    `SELECT COUNT(*)::integer AS total FROM items i
       LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
       WHERE i.company_id=$1 AND ${predicate}`, [companyId],
  );
  return { items: count.rows[0]?.total ?? 0, batches: 0 };
}

async function expiryTotals(client: PoolClient, companyId: number,
  code: typeof expiryTypes[number]) {
  // Exactly the positive stock, active-item/location/branch and batch date
  // predicates used by the existing expiry scanner. No per-item re-counts.
  const dateTest = code === "ITEM_EXPIRED"
    ? "s.batch_key < clock.today::text"
    : "s.batch_key >= clock.today::text AND s.batch_key <= (clock.today + 30)::text";
  const result = await client.query<{ items: number; batches: number }>(
    `WITH clock AS MATERIALIZED(
        SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date AS today)
      SELECT COUNT(DISTINCT s.item_id)::integer AS items,
        COUNT(*)::integer AS batches
      FROM stock_balances s CROSS JOIN clock
      JOIN items i ON i.company_id=s.company_id AND i.id=s.item_id
        AND i.active AND i.has_expiry
      JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id AND l.active
      JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id AND b.active
      WHERE s.company_id=$1 AND s.quantity_smallest>0 AND s.batch_key<>''
        AND (${dateTest})`, [companyId],
  );
  return result.rows[0] ?? { items: 0, batches: 0 };
}

async function closeObsoleteAlerts(client: PoolClient, companyId: number,
  code: GroupedStockAlertCode, count: number) {
  // Old per-item/per-lot alerts become historical entries when the
  // corresponding aggregate monitor takes over; no identity is edited.
  // An aggregate closes only after EVERY matching item/lot is resolved.
  await client.query(
    `UPDATE notifications SET completed_at=clock_timestamp(),
         read_at=COALESCE(read_at,clock_timestamp()),
         snoozed_until=NULL,next_reminder_at=NULL,
         revision=revision+1,updated_at=clock_timestamp()
       WHERE company_id=$1 AND code=$2 AND completed_at IS NULL
         AND (subject_key LIKE 'item:%' OR subject_key LIKE 'stock-balance:%'
           OR ($3::boolean AND subject_key='aggregate:'||$2))`,
    [companyId,code,count===0],
  );
}

export async function scanGroupedStockAlert(client: PoolClient, companyId: number,
  code: GroupedStockAlertCode): Promise<number> {
  const template = await effectiveTemplate(client,companyId,code);
  if (!template?.implemented || !template.enabled) return 0;
  if (code !== "ITEM_ORDER_LEVEL") {
    const blocked = await client.query(
      `SELECT 1 FROM page_settings WHERE page_key='company.stock-balances'
         AND (company_id IS NULL OR company_id=$1) AND NOT enabled LIMIT 1`,
      [companyId],
    );
    if (blocked.rowCount) return 0;
  }

  const hours = stockAlertCheckHours(template.minIntervalHours);
  const checkedAt = await dueToScan(client,companyId,code,hours);
  if (!checkedAt) return 0;

  const summary = code === "ITEM_ORDER_LEVEL"
    ? await orderShortages(client,companyId)
    : await expiryTotals(client,companyId,code);
  await closeObsoleteAlerts(client,companyId,code,summary.items);
  if (summary.items === 0) return 0;

  const message = code === "ITEM_ORDER_LEVEL"
    ? `يوجد ${summary.items} صنفًا وصل مخزونه إلى حد الطلب أو دونه. افتح متابعة حدود الطلب لمعرفة الأصناف.`
    : code === "ITEM_EXPIRED"
    ? `يوجد ${summary.items} صنفًا لديه ${summary.batches} دفعة منتهية الصلاحية وبها رصيد موجب. افتح متابعة الأصناف المنتهية.`
    : `يوجد ${summary.items} صنفًا لديه ${summary.batches} دفعة ستنتهي خلال 30 يومًا وبها رصيد موجب. افتح صفحة المتابعة.`;
  const path = code === "ITEM_ORDER_LEVEL" ? "item-order-levels?level=low"
    : code === "ITEM_EXPIRED" ? "expired-items-follow-up"
    : "expiring-items-follow-up";
  await emitNotification(client,{
    code,companyId,
    subjectKey:"aggregate:"+code,
    eventKey:`aggregate:${code}:checked:${checkedAt.toISOString()}`,
    streamKey:"aggregate-stock-alert",
    title:code === "ITEM_ORDER_LEVEL" ? "إذا كمية الطلب للأصناف الخاصة"
      : code === "ITEM_EXPIRED" ? "صنف تجاوز تاريخ الانتهاء"
      : "صنف سينتهي خلال 30 يومًا",
    message,
    href:`/companies/${companyId}/${path}`,
  });
  return summary.items;
}

export async function scanGroupedExpiryAlerts(client: PoolClient, companyId: number) {
  for (const code of expiryTypes) await scanGroupedStockAlert(client,companyId,code);
}

import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0,120);
}

/** At most one alert per item and local day. A stock change later in the
 * day remains eligible, unlike a once-daily company-wide scan.
 * Uses exact showroom + non-return warehouse quantities in smallest units.
 * NULL disables reminders; a configured zero is an active threshold.
 * No invoices, inventory or balances are modified. */
export async function scanDailyItemOrderReminders(
  client: PoolClient, companyId: number,
): Promise<number> {
  const today = (await client.query<{ today: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
  )).rows[0]!.today;
  const sql = [
    "SELECT i.id,i.name,",
    " round((COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))::numeric",
    " / GREATEST(i.factor2::numeric*i.factor3::numeric,1),4)::text AS available_unit1,",
    " i.order_alert_quantity::text AS threshold",
    " FROM items i",
    " LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id",
    " LEFT JOIN item_order_reminder_days sent",
    " ON sent.company_id=i.company_id AND sent.item_id=i.id AND sent.scan_day=$2::date",
    " WHERE i.company_id=$1 AND i.active AND i.order_alert_quantity IS NOT NULL",
    " AND sent.item_id IS NULL",
    " AND COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)",
    " <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric",
    " ORDER BY i.id",
  ].join(" ");
  const low = await client.query<{ id: number; name: string; available_unit1: string; threshold: string }>(
    sql,[companyId,today],
  );
  if (low.rows.length) {
    const recipients = await client.query<{ id: number; employee_id: number | null }>(
      [
        "SELECT DISTINCT ON(u.id) u.id,",
        " CASE WHEN u.owner THEN NULL ELSE e.id END AS employee_id",
        " FROM users u",
        " LEFT JOIN employees e ON e.company_id=$1 AND e.user_id=u.id AND e.active",
        " WHERE NOT u.archived AND",
        " (u.owner OR 'sales'=ANY(COALESCE(e.position_keys,'{}'::text[])))",
        " ORDER BY u.id,e.id",
      ].join(" "),[companyId],
    );
    for (const item of low.rows) {
      if (!recipients.rows.length) break;
      const claimed = await client.query(
        "INSERT INTO item_order_reminder_days(company_id,item_id,scan_day) " +
        "VALUES($1,$2,$3::date) ON CONFLICT DO NOTHING RETURNING item_id",
        [companyId,item.id,today],
      );
      if (!claimed.rowCount) continue;
      const name = safeName(item.name);
      for (const person of recipients.rows) {
        await emitNotification(client,{
          code: "ITEM_ORDER_LEVEL",
          companyId,
          recipientUserId: person.id,
          subjectEmployeeId: person.employee_id,
          explicitSubjectOnly: true,
          subjectKey: "item:" + item.id + ":date:" + today,
          eventKey: "item-order-level:" + item.id + ":" + today,
          title: "إذا كمية الطلب للأصناف الخاصة: " + name,
          message: "رصيد الصنف «" + name + "» دون مخازن المرتجعات " +
            item.available_unit1 + " بالوحدة الأولى، وكمية الطلب المحددة " +
            item.threshold + ".",
          href: "/companies/" + companyId + "/items/" + item.id,
        });
      }
    }
  }
  return low.rows.length;
}

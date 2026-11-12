import type { PoolClient } from "pg";
import { emitNotification, effectiveTemplate } from "./notifications.ts";

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 120);
}

/** Scan the exact showroom + non-return warehouse quantity in smallest units.
 * A configured zero is an active threshold; NULL disables the reminder.
 * Each passage from above the limit to at/below it opens ONE incident.
 * The previous notification history is preserved after recovery.
 * No invoices, stock balances, or inventory movements are modified.
 * The legacy exported name is retained for existing scheduled callers. */
export async function scanDailyItemOrderReminders(
  client: PoolClient, companyId: number,
): Promise<number> {
  // Close incidents whose item is now above its limit, archived, or no longer configured.
  // Completing an alert manually does not alter the item's stock or this incident state.
  const recovered = await client.query<{ item_id: number }>(
    `UPDATE item_order_notification_incidents incident
       SET active=false,updated_at=clock_timestamp()
       WHERE incident.company_id=$1 AND incident.active
         AND NOT EXISTS (
           SELECT 1 FROM items i
           LEFT JOIN item_statistics s
             ON s.company_id=i.company_id AND s.item_id=i.id
           WHERE i.company_id=incident.company_id AND i.id=incident.item_id
             AND i.active AND i.order_alert_quantity IS NOT NULL
             AND COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
                 <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric
         )
       RETURNING incident.item_id`,
    [companyId],
  );

  if (recovered.rows.length) {
    // Distinguish automatic recovery from a user's explicit "إنجاز" action.
    // The old records remain in the history, even when they were still open.
    await client.query(
      `WITH closed AS (
         UPDATE notifications n
           SET completed_at=clock_timestamp(),read_at=COALESCE(n.read_at,clock_timestamp()),
               snoozed_until=NULL,next_reminder_at=NULL,
               revision=n.revision+1,updated_at=clock_timestamp()
         WHERE n.company_id=$1 AND n.code='ITEM_ORDER_LEVEL'
           AND n.completed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM unnest($2::integer[]) AS recovered(item_id)
             WHERE n.subject_key LIKE 'item:'||recovered.item_id::text||':%'
           )
         RETURNING n.id
       )
       INSERT INTO notification_auto_resolutions(notification_id,reason)
       SELECT id,'item_order_level_recovered' FROM closed
       ON CONFLICT DO NOTHING`,
      [companyId,recovered.rows.map(row=>row.item_id)],
    );
  }

  const low = await client.query<{
    id: number; name: string; available_unit1: string; threshold: string;
  }>(
    `SELECT i.id,i.name,
       round((COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))::numeric
         / GREATEST(i.factor2::numeric*i.factor3::numeric,1),4)::text AS available_unit1,
       i.order_alert_quantity::text AS threshold
       FROM items i
       LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
       WHERE i.company_id=$1 AND i.active AND i.order_alert_quantity IS NOT NULL
         AND COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
             <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric
       ORDER BY i.id`,
    [companyId],
  );
  if (!low.rows.length) return 0;

  // Existing recipients stay the same, except that the owner receives this
  // category only when explicitly subscribed to it.
  const template = await effectiveTemplate(client,companyId,"ITEM_ORDER_LEVEL");
  const recipients = template?.enabled
    ? await client.query<{ id: number; employee_id: number | null }>(
      `SELECT DISTINCT ON(u.id) u.id,
         CASE WHEN u.owner THEN NULL ELSE e.id END AS employee_id
         FROM users u
         LEFT JOIN employees e ON e.company_id=$1 AND e.user_id=u.id AND e.active
         WHERE NOT u.archived AND NOT u.suspended
           AND ((u.owner AND $2::boolean) OR
                (NOT u.owner AND 'sales'=ANY(COALESCE(e.position_keys,'{}'::text[]))))
         ORDER BY u.id,e.id`,
      [companyId,template.notifyOwner],
    )
    : null;

  for (const item of low.rows) {
    const incident = (await client.query<{episode:number}>(
      `INSERT INTO item_order_notification_incidents(company_id,item_id,episode,active)
         VALUES($1,$2,1,true)
         ON CONFLICT(company_id,item_id) DO UPDATE
           SET episode=CASE WHEN item_order_notification_incidents.active
                            THEN item_order_notification_incidents.episode
                            ELSE item_order_notification_incidents.episode+1 END,
               active=true,updated_at=clock_timestamp()
         RETURNING episode`,
      [companyId,item.id],
    )).rows[0];
    if (!recipients?.rows.length) continue;
    const itemName = safeName(item.name);
    for (const person of recipients.rows) {
      await emitNotification(client,{
        code:"ITEM_ORDER_LEVEL",
        companyId,
        recipientUserId:person.id,
        subjectEmployeeId:person.employee_id,
        explicitSubjectOnly:true,
        subjectKey:`item:${item.id}:episode:${incident.episode}`,
        eventKey:`item-order-level:${item.id}:episode:${incident.episode}`,
        title:"إذا كمية الطلب للأصناف الخاصة: " + itemName,
        message:"رصيد الصنف «" + itemName + "» دون مخازن المرتجعات " +
          item.available_unit1 + " بالوحدة الأولى، وكمية الطلب المحددة " +
          item.threshold + ".",
        href:`/companies/${companyId}/items/${item.id}`,
      });
    }
  }
  return low.rows.length;
}

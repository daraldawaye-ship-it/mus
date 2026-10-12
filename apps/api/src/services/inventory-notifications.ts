import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

// Values are displayed as plain text; strip controls that could obscure an alert.
const name = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();

/** Observe current operational balances, without changing stock or its history. */
export async function scanInventoryNotifications(
  client: PoolClient,
  companyId: number,
): Promise<void> {
  const disabled = await client.query(
    `SELECT 1 FROM page_settings WHERE page_key='company.stock-balances'
     AND (company_id IS NULL OR company_id=$1) AND NOT enabled LIMIT 1`,
    [companyId],
  );
  if (disabled.rowCount) return;

  const negative = await client.query(
    `WITH balances AS (
       SELECT s.item_id,s.location_id,i.name AS item_name,l.name AS location_name,
         CASE WHEN i.factor3>1 THEN i.unit3_name WHEN i.factor2>1 THEN i.unit2_name ELSE i.unit1_name END AS unit_name,
         sum(s.quantity_smallest) AS quantity
       FROM stock_balances s
       JOIN items i ON i.company_id=s.company_id AND i.id=s.item_id AND i.active
       JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id AND l.active
       JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id AND b.active
       WHERE s.company_id=$1
       GROUP BY s.item_id,s.location_id,i.name,l.name,i.factor2,i.factor3,i.unit1_name,i.unit2_name,i.unit3_name
       HAVING sum(s.quantity_smallest)<0
     ) SELECT balances.*,latest.id AS movement_id
     FROM balances CROSS JOIN LATERAL (
       SELECT max(m.id) AS id FROM stock_movements m
       WHERE m.company_id=$1 AND m.item_id=balances.item_id AND m.location_id=balances.location_id
     ) latest ORDER BY balances.item_id,balances.location_id`,
    [companyId],
  );
  for (const row of negative.rows) {
    const subjectKey = `item:${row.item_id}:location:${row.location_id}`;
    await emitNotification(client, {
      code: "INVENTORY_NEGATIVE",
      companyId,
      subjectKey,
      eventKey: `INVENTORY_NEGATIVE:${subjectKey}:movement:${row.movement_id ?? "none"}`,
      message: `رصيد الصنف «${name(row.item_name)}» في «${name(row.location_name)}» أصبح سالبًا: ${row.quantity} ${name(row.unit_name)}.`,
      href: `/companies/${companyId}/stock-balances?itemId=${row.item_id}&locationId=${row.location_id}`,
    });
  }

  const expiry = await client.query(
    `WITH clock AS MATERIALIZED (
       SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date AS today
     ) SELECT s.id,s.item_id,s.location_id,s.batch_key,s.quantity_smallest,
       i.name AS item_name,l.name AS location_name,
       CASE WHEN s.batch_key<clock.today::text THEN 'ITEM_EXPIRED' ELSE 'ITEM_EXPIRING_30' END AS code,
       latest.id AS receipt_id
     FROM stock_balances s CROSS JOIN clock
     JOIN items i ON i.company_id=s.company_id AND i.id=s.item_id AND i.active AND i.has_expiry
     JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id AND l.active
     JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id AND b.active
     CROSS JOIN LATERAL (
       SELECT max(m.id) AS id FROM stock_movements m
       WHERE m.company_id=s.company_id AND m.item_id=s.item_id AND m.location_id=s.location_id
         AND m.batch_key=s.batch_key AND m.quantity_smallest>0
     ) latest
     WHERE s.company_id=$1 AND s.quantity_smallest>0 AND s.batch_key<>''
       AND s.batch_key<=(clock.today+30)::text
     ORDER BY s.batch_key,s.id`,
    [companyId],
  );
  for (const row of expiry.rows) {
    await emitNotification(client, {
      code: row.code,
      companyId,
      subjectKey: `stock-balance:${row.id}`,
      // Withdrawals do not create another reason after completion; a new receipt does.
      eventKey: `${row.code}:stock-balance:${row.id}:expiry:${row.batch_key}:receipt:${row.receipt_id ?? "none"}`,
      message: `الصنف «${name(row.item_name)}» في «${name(row.location_name)}» ${row.code === "ITEM_EXPIRED" ? "تجاوز تاريخ انتهاء الصلاحية" : "سينتهي خلال 30 يومًا"}: ${row.batch_key}.`,
      href: `/companies/${companyId}/stock-balances?itemId=${row.item_id}&locationId=${row.location_id}`,
    });
  }
}

export const produceInventoryNotifications = scanInventoryNotifications;

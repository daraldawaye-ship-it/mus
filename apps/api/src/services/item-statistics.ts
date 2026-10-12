import type { PoolClient } from "pg";
import type {
  ItemStatistics,
  User,
} from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";

export async function readItemStatistics(
  client: PoolClient,
  user: User,
  companyId: number,
  itemId: number,
): Promise<ItemStatistics> {
  const item = (
    await client.query("SELECT * FROM items WHERE company_id=$1 AND id=$2", [
      companyId,
      itemId,
    ])
  ).rows[0];
  if (!item) missing();
  const pages = await directoryEntries(client, user, companyId);
  const allowed = (key: string) =>
    !!pages.find((p) => p.key === key)?.actionAccess.view;
  const canViewStock =
    allowed("company.stock-balances") && allowed("company.stock-movements");
  const canViewCommerce =
    allowed("company.sales") &&
    allowed("company.purchases") &&
    allowed("company.invoice");
  const row = (
    await client.query(
      `SELECT s.*,s.stock_total::text AS stock_total,s.stock_showroom::text AS stock_showroom,s.stock_warehouse::text AS stock_warehouse
 FROM item_statistics s WHERE s.company_id=$1 AND s.item_id=$2`,
      [companyId, itemId],
    )
  ).rows[0];
  if (!row) missing("إحصائيات الصنف غير متاحة");
  const invoice = async (invoiceId: number) => {
    const r = (
      await client.query(
        "SELECT i.*,i.document_date::text AS day,u.display_name AS user_name FROM invoices i JOIN users u ON u.id=i.created_by WHERE i.company_id=$1 AND i.id=$2 AND i.posted",
        [companyId, invoiceId],
      )
    ).rows[0];
    return r
      ? {
          invoiceId: r.id,
          invoiceNumber: r.number,
          documentDate: r.day,
          createdAt: r.created_at.toISOString(),
          userName: r.user_name,
        }
      : null;
  };
  let lastPurchase: ItemStatistics["lastPurchase"] = null,
    lastSale: ItemStatistics["lastSale"] = null,
    lastMovement: ItemStatistics["lastMovement"] = null,
    lastAdjustment: ItemStatistics["lastAdjustment"] = null;
  if (canViewCommerce) {
    if (row.last_sale_invoice_id)
      lastSale = await invoice(row.last_sale_invoice_id);
    if (row.last_purchase_line_id) {
      const p = (
        await client.query(
          "SELECT l.unit_price::text AS price,l.unit_name,i.*,i.document_date::text AS day,u.display_name AS user_name FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id JOIN users u ON u.id=i.created_by WHERE l.company_id=$1 AND l.id=$2 AND i.posted",
          [companyId, row.last_purchase_line_id],
        )
      ).rows[0];
      if (p)
        lastPurchase = {
          invoiceId: p.id,
          invoiceNumber: p.number,
          documentDate: p.day,
          createdAt: p.created_at.toISOString(),
          userName: p.user_name,
          price: p.price.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""),
          unitName: p.unit_name,
          currencyCode: p.currency_code,
          accountName: p.counterparty_account_name,
        };
    }
  }
  if (canViewStock) {
    if (row.last_movement_id) {
      const m = (
        await client.query(
          "SELECT id,kind,document_date::text AS day,created_at FROM stock_movements WHERE company_id=$1 AND id=$2",
          [companyId, row.last_movement_id],
        )
      ).rows[0];
      if (m)
        lastMovement = {
          id: m.id,
          kind: m.kind,
          documentDate: m.day,
          createdAt: m.created_at.toISOString(),
        };
    }
    if (row.last_adjustment_movement_id) {
      const a = (
        await client.query(
          "SELECT o.id,o.document_date::text AS day,o.created_at,u.display_name AS user_name FROM stock_movements m JOIN stock_operations o ON o.company_id=m.company_id AND o.id=m.operation_id JOIN users u ON u.id=o.created_by WHERE m.company_id=$1 AND m.id=$2",
          [companyId, row.last_adjustment_movement_id],
        )
      ).rows[0];
      if (a)
        lastAdjustment = {
          id: a.id,
          documentDate: a.day,
          createdAt: a.created_at.toISOString(),
          userName: a.user_name,
        };
    }
  }
  return {
    itemId,
    companyId,
    updatedAt: row.updated_at.toISOString(),
    canViewStock,
    canViewCommerce,
    stock: canViewStock
      ? {
          total: row.stock_total,
          showroom: row.stock_showroom,
          warehouse: row.stock_warehouse,
          unitName:
            item.factor3 > 1
              ? item.unit3_name
              : item.factor2 > 1
                ? item.unit2_name
                : item.unit1_name,
        }
      : null,
    lastMovement,
    lastSale,
    lastPurchase,
    lastAdjustment,
  };
}

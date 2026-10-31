import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { applyStock, auditStockOperation, createStockOperation, requireInventorySettings } from "./inventory.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";

const SOURCE = "dar-aldawa-legacy-2026-10";
const abs = (n: bigint) => n < 0n ? -n : n;
const fail = (code: string, message: string): never => {
  throw new HttpError(409, code, message);
};
const batchWhere = "s.company_id=2 AND s.source_system='dar-aldawa-legacy-2026-10' " +
  "AND s.source_kind='invoice' AND s.created_at >= '2026-10-30 00:00+00'::timestamptz " +
  "AND s.created_at < '2026-10-31 00:00+00'::timestamptz";
const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const integer = /^-?(?:0|[1-9]\d*)$/;
function sign(s: string): -1 | 1 {
  if (!numeric.test(s) || !/[1-9]/.test(s))
    return fail("invalid_source_quantity", "كمية المصدر غير صالحة");
  return s.startsWith("-") ? -1 : 1;
}

export async function legacy127Summary(client: PoolClient) {
  const row = (await client.query(
    "SELECT count(*)::int AS invoices, " +
    "count(*) FILTER(WHERE i.kind='sale')::int AS sales, " +
    "count(*) FILTER(WHERE i.kind='purchase')::int AS purchases, " +
    "coalesce(sum((SELECT count(*) FROM invoice_lines l " +
    "WHERE l.company_id=2 AND l.invoice_id=i.id)) FILTER(WHERE i.kind='sale'),0)::int AS sales_lines " +
    "FROM transaction_source_imports s " +
    "JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id WHERE " + batchWhere
  )).rows[0];
  const corrected = (await client.query(
    "SELECT count(*)::int AS n FROM legacy_sales_sign_repairs r " +
    "JOIN transaction_source_imports s ON s.company_id=r.company_id AND s.invoice_id=r.invoice_id " +
    "WHERE " + batchWhere
  )).rows[0].n as number;
  return { companyId: 2, sourceSystem: SOURCE, importDayUtc: "2026-10-30",
    importedInvoices: row.invoices as number, sales: row.sales as number,
    purchasesUnchanged: row.purchases as number, saleLines: row.sales_lines as number,
    corrected, remaining: (row.sales as number) - corrected };
}

export function assertLegacy127Scope(summary: Awaited<ReturnType<typeof legacy127Summary>>) {
  if (summary.importedInvoices !== 127 || summary.sales !== 126 ||
      summary.purchasesUnchanged !== 1 || summary.saleLines !== 560 ||
      summary.corrected < 0 || summary.remaining < 0)
    fail("legacy_batch_changed", "تغير نطاق الدفعة المحددة؛ أوقف التصحيح لحماية الفواتير");
}
type CorrectionLine = {
  lineNumber: number; quantity: string; smallestQuantity: string; gross: string;
  total: string; baseTotal: string; costBase: string;
};
type RepairResult = {
  invoiceId: number; sourceId: string; stockOperationId: number;
  revenueDocumentId: number | null; costDocumentId: number | null;
};

/** Append-only and idempotent: original posted documents and stock movements stay immutable. */
export async function repairNextLegacy127(
  client: PoolClient, user: User, limit: number,
): Promise<{ repaired: RepairResult[]; summary: Awaited<ReturnType<typeof legacy127Summary>> }> {
  await client.query("SELECT pg_advisory_xact_lock(2,1272026)");
  assertLegacy127Scope(await legacy127Summary(client));
  const settings = await requireInventorySettings(client,2);
  if (!settings.allowNegative)
    fail("negative_inventory_disabled", "سياسة السماح بالمخزون السالب غير فعالة");
  const records = (await client.query(
    "SELECT s.source_id,s.source_metadata,i.* FROM transaction_source_imports s " +
    "JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id " +
    "WHERE " + batchWhere + " AND i.kind='sale' " +
    "AND NOT EXISTS(SELECT 1 FROM legacy_sales_sign_repairs r WHERE r.company_id=2 AND r.invoice_id=i.id) " +
    "ORDER BY i.id LIMIT $1 FOR UPDATE OF i,s", [limit]
  )).rows;
  const date = new Date().toISOString().slice(0,10);
  const repaired: RepairResult[] = [];
  for (const invoice of records) {
    if (!invoice.posted || moneyUnits(String(invoice.discount)) !== 0n ||
        invoice.currency_id !== settings.baseCurrencyId ||
        String(invoice.exchange_rate).replace(/\.0+$/, "") !== "1")
      fail("unexpected_invoice", "فاتورة بخصم أو عملة مختلفة تحتاج مراجعة خاصة");
    const sourceRows = invoice.source_metadata?.sourceRows;
    if (!Array.isArray(sourceRows)) fail("missing_source", "حركات المصدر غير موجودة");
    const rows = (await client.query(
      "SELECT l.*,it.legacy_id::text AS legacy_item_id,m.id AS source_movement_id," +
      "m.kind AS movement_kind,m.location_id AS movement_location_id," +
      "m.quantity_smallest::text AS movement_quantity,m.cost_base::text AS movement_cost," +
      "(SELECT count(*)::int FROM stock_movements m2 " +
      "WHERE m2.company_id=2 AND m2.invoice_line_id=l.id) AS movement_count " +
      "FROM invoice_lines l JOIN items it ON it.company_id=l.company_id AND it.id=l.item_id " +
      "LEFT JOIN stock_movements m ON m.company_id=l.company_id AND m.invoice_line_id=l.id " +
      "WHERE l.company_id=2 AND l.invoice_id=$1 ORDER BY l.line_number", [invoice.id]
    )).rows;
    if (!rows.length || rows.length !== sourceRows.length)
      fail("source_rows_mismatch", "عدد سطور الفاتورة لا يطابق المصدر");
    const operationId = await createStockOperation(client,2,user,"adjustment",{
      documentDate:date,
      description:"تصحيح اتجاه مبيعات الفاتورة المرحّلة "+invoice.number,
      idempotencyKey:randomUUID(),
    });
    let originalTotal = 0n, inventoryDelta = 0n;
    const correctedLines: CorrectionLine[] = [];
    for (const [index,row] of rows.entries()) {
      const source = sourceRows[index] as Record<string, unknown>;
      const sourceQty = String(source?.["الكمية_المحسوبة_اخيرا"] ?? "");
      const invoiceQty = String(row.quantity), originalMove = String(row.movement_quantity);
      if (row.line_number !== index+1 || String(source?.["معرف_الصنف"] ?? "") !== row.legacy_item_id ||
          source?.["نوع_العمليه"] !== "فاتورة مبيعات" ||
          sign(sourceQty) !== sign(invoiceQty) ||
          row.movement_count !== 1 || !row.source_movement_id)
        fail("source_line_mismatch", "عدم مطابقة اتجاه أو معرف الصنف في السطر");
      if (!integer.test(invoiceQty) || !integer.test(String(row.smallest_quantity)) ||
          !integer.test(originalMove) || BigInt(originalMove) === 0n ||
          BigInt(originalMove) !== -BigInt(String(row.smallest_quantity)) ||
          row.movement_location_id !== invoice.location_id ||
          row.movement_kind !== (BigInt(invoiceQty) < 0n ? "sales_return" : "sale"))
        fail("stock_line_mismatch", "سطر المخزون لا يطابق الفاتورة");
      const delta = -2n*BigInt(originalMove);
      const moveCost = moneyUnits(String(row.movement_cost));
      const correction = await applyStock(client,2,user.id,{
        itemId:row.item_id, locationId:row.movement_location_id,
        quantitySmallest:delta, kind:delta>0n?"adjustment_surplus":"adjustment_shortage",
        documentDate:date,operationId,allowInactive:true,allowExpired:true,allowUnknownExpiry:true,
        costBase:delta>0n?2n*abs(moveCost):undefined,
      });
      inventoryDelta += correction.costBase;
      originalTotal += moneyUnits(String(row.total));
      correctedLines.push({
        lineNumber:row.line_number,
        quantity:(-BigInt(invoiceQty)).toString(),
        smallestQuantity:(-BigInt(String(row.smallest_quantity))).toString(),
        gross:moneyString(-moneyUnits(String(row.gross))),
        total:moneyString(-moneyUnits(String(row.total))),
        baseTotal:moneyString(-moneyUnits(String(row.base_total))),
        costBase:moneyString(moneyUnits(String(row.cost_base))-correction.costBase),
      });
    }
    if (moneyUnits(String(invoice.total)) !== originalTotal ||
        moneyUnits(String(invoice.gross)) !== originalTotal)
      fail("invoice_total_mismatch","إجمالي سطور الفاتورة غير متطابق");
    const pair = (value:bigint,debitId:number,creditId:number,label:string) => {
      if (value===0n) return [];
      const debit=value>0n?debitId:creditId,credit=value>0n?creditId:debitId;
      const amount=moneyString(abs(value));
      return [
        {accountId:debit,debit:amount,credit:"0",description:label},
        {accountId:credit,debit:"0",credit:amount,description:label},
      ];
    };
    const sales = pair(-2n*originalTotal,invoice.counterparty_account_id,
      settings.salesAccountId,"مصالحة قيمة فاتورة "+invoice.number);
    const cost = pair(-inventoryDelta,settings.cogsAccountId,settings.inventoryAccountId,
      "مصالحة تكلفة فاتورة "+invoice.number);
    const revenueDocumentId = sales.length ? await postCommerceJournal(client,2,user,{
      documentDate:date,branchId:invoice.branch_id,currencyId:invoice.currency_id,
      description:"قيد تصحيح إيراد فاتورة "+invoice.number,
      idempotencyKey:randomUUID(),lines:sales,
    }):null;
    const costDocumentId = cost.length ? await postCommerceJournal(client,2,user,{
      documentDate:date,branchId:invoice.branch_id,currencyId:settings.baseCurrencyId,
      description:"قيد تصحيح تكلفة ومخزون فاتورة "+invoice.number,
      idempotencyKey:randomUUID(),lines:cost,
    }):null;
    if (costDocumentId !== null)
      await client.query("UPDATE stock_operations SET financial_document_id=$1 WHERE company_id=2 AND id=$2",
        [costDocumentId,operationId]);
    await client.query(
      "INSERT INTO legacy_sales_sign_repairs(company_id,invoice_id,source_id,line_snapshots," +
      "previous_total,corrected_total,inventory_value_delta,stock_operation_id," +
      "revenue_document_id,cost_document_id,created_by) VALUES(2,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [invoice.id,invoice.source_id,JSON.stringify(correctedLines),
        moneyString(originalTotal),moneyString(-originalTotal),
        moneyString(inventoryDelta),operationId,revenueDocumentId,costDocumentId,user.id]
    );
    const daily = new Map<number,{sold:bigint;returned:bigint;soldLines:number;returnLines:number}>();
    for (const line of rows) {
      const quantity = BigInt(String(line.smallest_quantity));
      const item = daily.get(line.item_id) ?? {sold:0n,returned:0n,soldLines:0,returnLines:0};
      if (quantity>0n) {item.sold+=quantity;item.soldLines++;}
      else {item.returned-=quantity;item.returnLines++;}
      daily.set(line.item_id,item);
    }
    for (const [itemId,item] of daily) {
      const countDiff=Number(item.returnLines>0)-Number(item.soldLines>0);
      const lineDiff=item.returnLines-item.soldLines;
      const quantityDiff=item.returned-item.sold;
      const state=await client.query(
        "UPDATE item_daily_activity SET sale_invoices=sale_invoices+$3, " +
        "sale_return_invoices=sale_return_invoices-$3, " +
        "sale_lines=sale_lines+$4,sale_return_lines=sale_return_lines-$4, " +
        "sale_quantity=sale_quantity+$5::numeric,sale_return_quantity=sale_return_quantity-$5::numeric, " +
        "updated_at=clock_timestamp() WHERE company_id=2 AND item_id=$1 AND document_date=$2::date " +
        "AND sale_invoices+$3>=0 AND sale_return_invoices-$3>=0 " +
        "AND sale_lines+$4>=0 AND sale_return_lines-$4>=0 " +
        "AND sale_quantity+$5::numeric>=0 AND sale_return_quantity-$5::numeric>=0 RETURNING item_id",
        [itemId,invoice.document_date,countDiff,lineDiff,quantityDiff.toString()]
      );
      if(state.rowCount!==1) fail("daily_activity_mismatch","إحصائية المبيعات لا تطابق الفاتورة");
      if(item.returnLines>0) await client.query(
        "INSERT INTO item_statistics(company_id,item_id,last_sale_invoice_id) VALUES(2,$1,$2) " +
        "ON CONFLICT(company_id,item_id) DO UPDATE SET " +
        "last_sale_invoice_id=GREATEST(item_statistics.last_sale_invoice_id,EXCLUDED.last_sale_invoice_id)," +
        "updated_at=clock_timestamp()",
        [itemId,invoice.id]
      );
    }
    await auditStockOperation(client,2,user,operationId);
    await audit(client,user,"stock.adjustment","legacySalesSignRepair",invoice.id,
      {sourceId:invoice.source_id,oldTotal:moneyString(originalTotal)},
      {sourceId:invoice.source_id,newTotal:moneyString(-originalTotal),
        inventoryDelta:moneyString(inventoryDelta),operationId,revenueDocumentId,costDocumentId,
        lines:correctedLines.length},2);
    repaired.push({invoiceId:invoice.id,sourceId:invoice.source_id,stockOperationId:operationId,
      revenueDocumentId,costDocumentId});
  }
  return {repaired,summary:await legacy127Summary(client)};
}

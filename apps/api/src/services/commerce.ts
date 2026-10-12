import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { z } from "zod";
import {
  calculateInvoiceTotals,
  normalizeRate,
  type Invoice,
  type InvoiceLine,
  type User,
  type invoiceSchema,
} from "../../../../packages/contracts/src/index.ts";
import type { Database } from "../db.ts";
import { HttpError, missing } from "../errors.ts";
import { audit } from "./audit.ts";
import { conflict } from "./masters.ts";
import {
  checkQuantum,
  convertedUnits,
  moneyString,
  moneyUnits,
  quantum,
} from "./finance.ts";
import {
  applyStock,
  checkStockLocation,
  requireInventorySettings,
  stockUnitMultiplier,
} from "./inventory.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";

type InvoiceFields = z.output<typeof invoiceSchema>;
const abs = (value: bigint) => (value < 0n ? -value : value);
const maximumMoney = 10n ** 28n - 1n;
function assertAmount(value: bigint): void {
  if (abs(value) > maximumMoney)
    throw new HttpError(
      400,
      "amount_overflow",
      "إجمالي الفاتورة أو السطر يتجاوز الحد المالي المدعوم",
    );
}
function share(
  value: bigint,
  part: bigint,
  total: bigint,
  step: bigint,
): bigint {
  const denominator = total * step;
  return (
    ((value * part) / denominator +
      (((value * part) % denominator) * 2n >= denominator ? 1n : 0n)) *
    step
  );
}
function allocate(total: bigint, weights: bigint[], step: bigint): bigint[] {
  const sum = weights.reduce((value, weight) => value + weight, 0n);
  const result = weights.map((weight) =>
    sum === 0n ? 0n : ((total * weight) / sum / step) * step,
  );
  let remaining = total - result.reduce((value, weight) => value + weight, 0n);
  for (let index = 0; remaining > 0n && index < result.length; index++)
    if (weights[index] !== 0n) {
      result[index] += step;
      remaining -= step;
    }
  if (remaining !== 0n) throw new Error("Invalid exact allocation");
  return result;
}
export const invoiceFrom = "FROM invoices i JOIN users u ON u.id=i.created_by";
export const invoiceSelect = `SELECT i.*,i.document_date::text AS date_text,u.display_name AS created_by_name ${invoiceFrom}`;
export function invoiceLineDTO(row: QueryResultRow): InvoiceLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    unit: row.unit,
    unitName: row.unit_name,
    factor2: row.factor2,
    factor3: row.factor3,
    purchaseFactor: row.purchase_factor,
    quantity: row.quantity,
    smallestQuantity: row.smallest_quantity,
    unitPrice: normalizeRate(row.unit_price),
    gross: normalizeRate(row.gross),
    discount: normalizeRate(row.discount),
    total: normalizeRate(row.total),
    baseTotal: normalizeRate(row.base_total),
    costBase: normalizeRate(row.cost_base),
    expiryDate: row.expiry_text ?? null,
    originalLineId: row.original_line_id,
  };
}
export async function invoiceDTOs(
  db: Database,
  rows: QueryResultRow[],
): Promise<Invoice[]> {
  if (!rows.length) return [];
  const lines = await db.query(
    "SELECT l.*,l.expiry_date::text AS expiry_text FROM invoice_lines l WHERE l.company_id=$1 AND l.invoice_id=ANY($2::integer[]) ORDER BY l.invoice_id,l.line_number",
    [rows[0].company_id, rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    number: row.number,
    kind: row.kind,
    status: "posted",
    returning: row.is_return,
    documentDate: row.date_text,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    currencyName: row.currency_name,
    decimalPlaces: row.decimal_places,
    baseCurrencyId: row.base_currency_id,
    baseCurrencyCode: row.base_currency_code,
    baseDecimalPlaces: row.base_decimal_places,
    exchangeRate: normalizeRate(row.exchange_rate),
    branchId: row.branch_id,
    branchName: row.branch_name,
    locationId: row.location_id,
    locationName: row.location_name,
    counterpartyAccountId: row.counterparty_account_id,
    counterpartyAccountCode: row.counterparty_account_code,
    counterpartyAccountName: row.counterparty_account_name,
    description: row.description,
    gross: normalizeRate(row.gross),
    discount: normalizeRate(row.discount),
    total: normalizeRate(row.total),
    baseTotal: normalizeRate(row.base_total),
    financialDocumentId: row.financial_document_id,
    costDocumentId: row.cost_document_id,
    varianceDocumentId: row.variance_document_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    lines: lines.rows
      .filter((line) => line.invoice_id === row.id)
      .map(invoiceLineDTO),
  }));
}
export async function loadInvoice(
  db: Database,
  companyId: number,
  invoiceId: number,
): Promise<Invoice> {
  const result = await db.query(
    `${invoiceSelect} WHERE i.company_id=$1 AND i.id=$2`,
    [companyId, invoiceId],
  );
  if (!result.rows[0]) missing();
  return (await invoiceDTOs(db, result.rows))[0];
}
interface PreparedLine {
  item: QueryResultRow;
  unit: 1 | 2 | 3;
  quantity: bigint;
  smallest: bigint;
  price: string;
  gross: bigint;
  discount: bigint;
  total: bigint;
  baseTotal: bigint;
  original: QueryResultRow | null;
  expiryDate: string | null;
}
export async function createInvoice(
  client: PoolClient,
  companyId: number,
  user: User,
  input: InvoiceFields,
): Promise<Invoice> {
  const replay = await client.query(
    "SELECT id,creation_payload=$3::jsonb AS same_payload FROM invoices WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, input.idempotencyKey, JSON.stringify(input)],
  );
  if (replay.rows[0]) {
    if (!replay.rows[0].same_payload)
      conflict("مفتاح الفاتورة مستخدم لبيانات مختلفة؛ أعد إرسال الطلب الأصلي");
    return loadInvoice(client, companyId, replay.rows[0].id);
  }
  const settings = await requireInventorySettings(client, companyId);
  const location = await checkStockLocation(
    client,
    companyId,
    input.locationId,
  );
  if (location.branchId !== input.branchId)
    conflict("الموقع لا يتبع فرع الفاتورة");
  const refs = await client.query(
    "SELECT c.*,b.name AS branch_name,l.name AS location_name,l.kind AS location_kind,a.code AS account_code,a.name AS account_name,a.category AS account_category FROM company_currencies c JOIN branches b ON b.company_id=c.company_id AND b.id=$3 JOIN locations l ON l.company_id=c.company_id AND l.id=$4 JOIN accounts a ON a.company_id=c.company_id AND a.id=$5 WHERE c.company_id=$1 AND c.id=$2 AND c.active AND a.active AND a.kind='posting' FOR SHARE OF c,b,l,a",
    [
      companyId,
      input.currencyId,
      input.branchId,
      input.locationId,
      input.counterpartyAccountId,
    ],
  );
  const currency = refs.rows[0];
  if (!currency)
    conflict("العملة والحساب المقابل يجب أن يكونا فعالين من الشركة");
  if (input.kind === "sale" && currency.location_kind !== "showroom")
    conflict("المبيعات ومردوداتها ترحل من معرض الفرع فقط");
  if (!["asset", "liability"].includes(currency.account_category))
    conflict("اختر حساب عميل أو مورد أو صندوق من الأصول أو الالتزامات");
  if (
    [
      settings.inventoryAccountId,
      settings.salesAccountId,
      settings.cogsAccountId,
      settings.surplusAccountId,
      settings.shortageAccountId,
    ].includes(input.counterpartyAccountId)
  )
    conflict("حساب الطرف لا يساوي حسابًا تشغيليًا للمخزون");
  const base = await client.query(
    "SELECT * FROM company_currencies WHERE company_id=$1 AND id=$2 AND active FOR SHARE",
    [companyId, settings.baseCurrencyId],
  );
  if (!base.rows[0]) conflict("العملة الأساسية غير فعالة");
  let rate = "1";
  if (input.currencyId !== settings.baseCurrencyId) {
    const rates = await client.query(
      "SELECT rate FROM exchange_rates WHERE company_id=$1 AND currency_id=$2 AND base_currency_id=$3 AND active AND effective_at < (($4::date+1)::timestamp AT TIME ZONE 'UTC') ORDER BY effective_at DESC,id DESC LIMIT 1",
      [
        companyId,
        input.currencyId,
        settings.baseCurrencyId,
        input.documentDate,
      ],
    );
    if (!rates.rows[0])
      conflict("سجل سعر صرف فعال بتاريخ الفاتورة قبل الترحيل");
    rate = normalizeRate(rates.rows[0].rate);
  }
  const returning = BigInt(input.lines[0].quantity) < 0n;
  const itemIds = [...new Set(input.lines.map((line) => line.itemId))].sort(
    (a, b) => a - b,
  );
  const items = await client.query(
    "SELECT * FROM items WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE",
    [companyId, itemIds],
  );
  if (
    items.rows.length !== itemIds.length ||
    (!returning && items.rows.some((item) => !item.active))
  )
    conflict("اختر أصنافًا فعالة من الشركة");
  const originals = new Map<number, QueryResultRow>();
  if (returning && input.lines.some((line) => line.originalLineId !== null)) {
    const ids = input.lines.map((line) => line.originalLineId).filter(
      (value): value is number => value !== null,
    );
    if (new Set(ids).size !== ids.length)
      conflict("لا تكرر سطر الأصل في فاتورة المردود");
    const rows = await client.query(
      "SELECT l.*,l.expiry_date::text AS expiry_text,i.kind AS invoice_kind,i.currency_id AS invoice_currency_id,i.counterparty_account_id AS invoice_account_id,i.location_id AS invoice_location_id,i.document_date::text AS invoice_date FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=$1 AND l.id=ANY($2::integer[]) AND l.quantity>0 ORDER BY l.id FOR UPDATE OF l",
      [companyId, ids.sort((a, b) => a - b)],
    );
    if (rows.rows.length !== ids.length)
      conflict("اختر سطورًا أصلية موجبة من الشركة");
    for (const row of rows.rows) originals.set(row.id, row);
  }
  const prepared: PreparedLine[] = [];
  for (const line of input.lines) {
    const item = items.rows.find((row) => row.id === line.itemId)!;
    const quantity = BigInt(line.quantity);
    let price: string,
      discount = 0n,
      original: QueryResultRow | null = null;
    const smallest = quantity * stockUnitMultiplier(item, line.unit);
    let expiryDate = line.expiryDate;
    if (returning && line.originalLineId !== null) {
      original = originals.get(line.originalLineId)!;
      if (
        original.item_id !== line.itemId ||
        original.unit !== line.unit ||
        original.invoice_kind !== input.kind ||
        original.invoice_currency_id !== input.currencyId ||
        original.invoice_account_id !== input.counterpartyAccountId
      )
        conflict("المردود يجب أن يطابق صنف ووحدة وعملة وحساب فاتورة الأصل");
      if (input.documentDate < original.invoice_date)
        conflict("تاريخ المردود لا يسبق فاتورة الأصل");
      if (
        input.kind === "sale" &&
        original.invoice_location_id !== input.locationId
      )
        conflict("مردود المبيعات يرجع إلى معرض فاتورة الأصل");
      const previous = await client.query(
        "SELECT COALESCE(sum(-quantity),0)::text AS quantity,COALESCE(sum(-discount),0)::text AS discount FROM invoice_lines WHERE company_id=$1 AND original_line_id=$2",
        [companyId, original.id],
      );
      const returned = BigInt(previous.rows[0].quantity),
        requested = abs(quantity),
        originalQuantity = BigInt(original.quantity);
      if (returned + requested > originalQuantity)
        conflict("كمية المردود تتجاوز الكمية المتبقية من سطر الأصل");
      price = normalizeRate(original.unit_price);
      if (line.unitPrice !== undefined && line.unitPrice !== price)
        conflict("سعر المردود محفوظ من الأصل ولا يعدل");
      if (line.expiryDate !== null && line.expiryDate !== original.expiry_text)
        conflict("دفعة المردود تحفظ من الأصل ولا تعدل");
      expiryDate = original.expiry_text;
      const remainingDiscount =
        moneyUnits(original.discount) - moneyUnits(previous.rows[0].discount);
      discount = -(returned + requested === originalQuantity
        ? remainingDiscount
        : (() => {
            const prorata = share(
              moneyUnits(original.discount),
              requested,
              originalQuantity,
              quantum(currency.decimal_places),
            );
            return prorata > remainingDiscount ? remainingDiscount : prorata;
          })());
      if (input.kind === "purchase") {
        if (
          line.expiryDate !== null &&
          line.expiryDate !== original.expiry_text
        )
          conflict("دفعة مردود المشتريات يجب أن تطابق دفعة الأصل");
        expiryDate = original.expiry_text;
      }
    } else {
      if (input.kind === "sale") {
        if (returning && line.originalLineId === null) {
          if (item.currency_id !== input.currencyId)
            conflict("عملة مردود المبيعات يجب أن تطابق عملة أسعار كرت الصنف.");
          price = normalizeRate(item[`sale_price${line.unit}`]);
          if (line.unitPrice !== undefined && line.unitPrice !== price)
            conflict("سعر مردود المبيعات المباشر من كرت الصنف.");
          checkQuantum(price, currency.decimal_places);
          if (!item.has_expiry && expiryDate !== null)
            conflict("الصنف لا يتتبع تاريخ الانتهاء.");
          // A direct customer return has no historical invoice allocation;
          // any provided expiry batch is retained, otherwise unspecified.
          if (item.has_expiry && expiryDate && expiryDate < input.documentDate)
            conflict("لا تقبل دفعة مردود منتهية الصلاحية دون مراجعة.");
        } else {
        if (expiryDate !== null)
          conflict(
            "دفعات المبيعات تختار تلقائيًا بحسب أقرب انتهاء؛ لا تدخل تاريخ انتهاء",
          );
        if (item.currency_id !== input.currencyId)
          conflict(
            "عملة البيع يجب أن تطابق عملة أسعار الصنف؛ لا تحويل أسعار ضمني",
          );
        price = normalizeRate(item[`sale_price${line.unit}`]);
        if (line.unitPrice !== undefined && line.unitPrice !== price)
          conflict("سعر البيع يؤخذ من كرت الصنف ولا يعدل داخل الفاتورة");
        }
      } else {
        if (
          line.unitPrice === undefined &&
          item.currency_id !== input.currencyId
        )
          conflict("أدخل سعر الشراء بعملة الفاتورة؛ العملة تختلف عن سعر الكرت");
        price = line.unitPrice ?? normalizeRate(item.purchase_price);
      }
      checkQuantum(price, currency.decimal_places);
      if (item.has_expiry && input.kind === "purchase" && expiryDate === null)
        conflict("تاريخ انتهاء الدفعة مطلوب للصنف");
      if (!item.has_expiry && expiryDate !== null)
        conflict("الصنف لا يستخدم دفعات انتهاء");
    }
    const gross = quantity * moneyUnits(price);
    assertAmount(gross);
    prepared.push({
      item,
      unit: line.unit,
      quantity,
      smallest,
      price,
      gross,
      discount,
      total: gross - discount,
      baseTotal: 0n,
      original,
      expiryDate,
    });
  }
  if (!returning) {
    checkQuantum(input.discount, currency.decimal_places);
    let totals: ReturnType<typeof calculateInvoiceTotals>;
    try {
      totals = calculateInvoiceTotals(
        prepared.map((line) => ({
          quantity: line.quantity.toString(),
          unitPrice: line.price,
        })),
        input.discount,
        currency.decimal_places,
      );
    } catch (error) {
      throw new HttpError(
        400,
        "invalid_discount",
        error instanceof Error ? error.message : "الخصم غير صالح",
      );
    }
    for (const [index, line] of prepared.entries()) {
      line.discount = moneyUnits(totals.lineDiscounts[index]);
      line.total = moneyUnits(totals.lineTotals[index]);
    }
  }
  const gross = prepared.reduce((sum, line) => sum + line.gross, 0n),
    discount = prepared.reduce((sum, line) => sum + line.discount, 0n),
    total = gross - discount;
  assertAmount(gross);
  assertAmount(total);
  const baseMagnitude = convertedUnits(
    moneyString(abs(total)),
    rate,
    settings.baseDecimalPlaces,
  );
  if (total !== 0n && baseMagnitude === 0n)
    throw new HttpError(
      400,
      "conversion_zero",
      "صافي الفاتورة أصغر من دقة العملة الأساسية",
    );
  const baseParts = allocate(
    baseMagnitude,
    prepared.map((line) => abs(line.total)),
    quantum(settings.baseDecimalPlaces),
  );
  for (const [index, line] of prepared.entries())
    line.baseTotal = returning ? -baseParts[index] : baseParts[index];
  const baseTotal = returning ? -baseMagnitude : baseMagnitude;
  const counter = await client.query(
    "INSERT INTO invoice_counters(company_id,next_number) VALUES($1,2) ON CONFLICT(company_id) DO UPDATE SET next_number=invoice_counters.next_number+1 RETURNING (next_number-1)::text AS number",
    [companyId],
  );
  const number = counter.rows[0].number.padStart(10, "0");
  const inserted = await client.query(
    "INSERT INTO invoices(company_id,number,kind,document_date,currency_id,currency_code,currency_name,decimal_places,base_currency_id,base_currency_code,base_decimal_places,exchange_rate,branch_id,branch_name,location_id,location_name,counterparty_account_id,counterparty_account_code,counterparty_account_name,description,gross,discount,total,base_total,created_by,idempotency_key,creation_payload,is_return) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id",
    [
      companyId,
      number,
      input.kind,
      input.documentDate,
      input.currencyId,
      currency.code,
      currency.name,
      currency.decimal_places,
      settings.baseCurrencyId,
      base.rows[0].code,
      settings.baseDecimalPlaces,
      rate,
      input.branchId,
      currency.branch_name,
      input.locationId,
      currency.location_name,
      input.counterpartyAccountId,
      currency.account_code,
      currency.account_name,
      input.description,
      moneyString(gross),
      moneyString(discount),
      moneyString(total),
      moneyString(baseTotal),
      user.id,
      input.idempotencyKey,
      JSON.stringify(input),
      returning,
    ],
  );
  const invoiceId = inserted.rows[0].id as number;
  let totalCost = 0n;
  for (const [index, line] of prepared.entries()) {
    const snapshot = line.original ?? line.item;
    const result = await client.query(
      "INSERT INTO invoice_lines(company_id,invoice_id,line_number,item_id,item_code,item_name,unit,unit_name,factor2,factor3,purchase_factor,quantity,smallest_quantity,unit_price,gross,discount,total,base_total,expiry_date,original_line_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id",
      [
        companyId,
        invoiceId,
        index + 1,
        line.item.id,
        line.original ? snapshot.item_code : snapshot.code,
        line.original ? snapshot.item_name : snapshot.name,
        line.unit,
        line.original ? snapshot.unit_name : snapshot[`unit${line.unit}_name`],
        snapshot.factor2,
        snapshot.factor3,
        snapshot.purchase_factor,
        line.quantity.toString(),
        line.smallest.toString(),
        line.price,
        moneyString(line.gross),
        moneyString(line.discount),
        moneyString(line.total),
        moneyString(line.baseTotal),
        line.expiryDate,
        line.original?.id ?? null,
      ],
    );
    const lineId = result.rows[0].id as number;
    let cost: bigint;
    if (returning && input.kind === "sale") {
      const moves = await client.query(
        "SELECT m.*,COALESCE((SELECT sum(r.quantity_smallest) FROM stock_movements r WHERE r.company_id=m.company_id AND r.original_movement_id=m.id),0)::text AS returned_quantity,COALESCE((SELECT sum(r.cost_base) FROM stock_movements r WHERE r.company_id=m.company_id AND r.original_movement_id=m.id),0)::text AS returned_cost FROM stock_movements m WHERE m.company_id=$1 AND m.invoice_line_id=$2 AND m.kind='sale' ORDER BY m.id",
        [companyId, line.original!.id],
      );
      let remaining = abs(line.smallest);
      cost = 0n;
      for (const move of moves.rows) {
        const available =
          -BigInt(move.quantity_smallest) - BigInt(move.returned_quantity);
        const taken = remaining < available ? remaining : available;
        if (taken <= 0n) continue;
        const residualCost =
          -moneyUnits(move.cost_base) - moneyUnits(move.returned_cost);
        const restoredCost =
          taken === available
            ? residualCost
            : (() => {
                const value = share(
                  -moneyUnits(move.cost_base),
                  taken,
                  -BigInt(move.quantity_smallest),
                  quantum(settings.baseDecimalPlaces),
                );
                return value > residualCost ? residualCost : value;
              })();
        const restored = await applyStock(client, companyId, user.id, {
          itemId: line.item.id,
          locationId: input.locationId,
          quantitySmallest: taken,
          kind: "sales_return",
          documentDate: input.documentDate,
          expiryDate: move.batch_key || null,
          costBase: restoredCost,
          invoiceId,
          invoiceLineId: lineId,
          originalMovementId: move.id,
          allowExpired: true,
          allowInactive: true,
        });
        cost -= restored.costBase;
        remaining -= taken;
      }
      if (remaining !== 0n)
        conflict("حركات الأصل لا تكفي لاستعادة كمية المردود");
    } else {
      const delta = input.kind === "sale" ? -line.smallest : line.smallest;
      let directReturnCost: bigint | undefined;
      if (input.kind === "sale" && returning && line.original === null) {
        // Derive an available historical unit-cost estimate; unlike a linked
        // customer return there is no original movement to reverse precisely.
        const previousSale = await client.query(
          "SELECT quantity_smallest,cost_base FROM stock_movements WHERE company_id=$1 AND item_id=$2 AND kind='sale' AND quantity_smallest<0 AND cost_base<0 ORDER BY id DESC LIMIT 1",
          [companyId,line.item.id],
        );
        const returnedQuantity = line.smallest;
        directReturnCost = previousSale.rows[0]
          ? share(-moneyUnits(previousSale.rows[0].cost_base),returnedQuantity,
              -BigInt(previousSale.rows[0].quantity_smallest),
              quantum(settings.baseDecimalPlaces))
          : 0n;
      }
      const movement = await applyStock(client, companyId, user.id, {
        itemId: line.item.id,
        locationId: input.locationId,
        quantitySmallest: delta,
        kind:
          input.kind === "sale"
            ? (returning ? "sales_return" : "sale")
            : returning
              ? "purchase_return"
              : "purchase",
        documentDate: input.documentDate,
        expiryDate: line.expiryDate,
        costBase:
          input.kind === "purchase" && !returning ? line.baseTotal : directReturnCost,
        invoiceId,
        invoiceLineId: lineId,
        allowExpired: returning,
        allowInactive: returning,
      });
      cost = input.kind === "sale" ? -movement.costBase : movement.costBase;
    }
    totalCost += cost;
    await client.query(
      "UPDATE invoice_lines SET cost_base=$1 WHERE company_id=$2 AND id=$3",
      [moneyString(cost), companyId, lineId],
    );
  }
  let discountAccountId: number | null = null;
  if (input.kind === "sale" && discount !== 0n) {
    const link = await client.query(
      "SELECT a.id FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.purpose='discountAllowed' AND a.active AND a.kind='posting' AND a.category='expense' FOR SHARE OF a",
      [companyId],
    );
    if (!link.rows[0])
      conflict(
        "اربط حساب الخصم المسموح به بحساب مصروف حركي فعال قبل ترحيل الخصم",
      );
    discountAccountId = link.rows[0].id;
  }
  const journalLines: {
    accountId: number;
    debit: string;
    credit: string;
    description: string;
  }[] = [];
  function add(
    accountId: number,
    value: bigint,
    debit: boolean,
    description: string,
  ) {
    if (value === 0n) return;
    const isDebit = value > 0n ? debit : !debit;
    journalLines.push({
      accountId,
      debit: isDebit ? moneyString(abs(value)) : "0",
      credit: isDebit ? "0" : moneyString(abs(value)),
      description,
    });
  }
  if (input.kind === "sale") {
    add(input.counterpartyAccountId, total, true, "صافي فاتورة المبيعات");
    if (discountAccountId !== null)
      add(discountAccountId, discount, true, "خصم المبيعات الموزع");
    add(settings.salesAccountId, gross, false, "إجمالي المبيعات");
  } else {
    add(settings.inventoryAccountId, total, true, "صافي تكلفة المشتريات");
    add(input.counterpartyAccountId, total, false, "حساب المشتريات");
  }
  const financialDocumentId = journalLines.length
    ? await postCommerceJournal(client, companyId, user, {
        documentDate: input.documentDate,
        branchId: input.branchId,
        currencyId: input.currencyId,
        description:
          `${input.kind === "sale" ? "مبيعات" : "مشتريات"} ${number} ${input.description}`.slice(
            0,
            1000,
          ),
        idempotencyKey: randomUUID(),
        lines: journalLines,
      })
    : null;
  let costDocumentId: number | null = null,
    varianceDocumentId: number | null = null;
  if (input.kind === "sale" && totalCost !== 0n) {
    const debit =
        totalCost > 0n ? settings.cogsAccountId : settings.inventoryAccountId,
      credit =
        totalCost > 0n ? settings.inventoryAccountId : settings.cogsAccountId;
    costDocumentId = await postCommerceJournal(client, companyId, user, {
      documentDate: input.documentDate,
      branchId: input.branchId,
      currencyId: settings.baseCurrencyId,
      description: `تكلفة مبيعات ${number}`,
      idempotencyKey: randomUUID(),
      lines: [
        {
          accountId: debit,
          debit: moneyString(abs(totalCost)),
          credit: "0",
          description: "تكلفة المخزون",
        },
        {
          accountId: credit,
          debit: "0",
          credit: moneyString(abs(totalCost)),
          description: "تكلفة المخزون",
        },
      ],
    });
  }
  if (input.kind === "purchase" && totalCost !== baseTotal) {
    const variance = totalCost - baseTotal;
    varianceDocumentId = await postCommerceJournal(client, companyId, user, {
      documentDate: input.documentDate,
      branchId: input.branchId,
      currencyId: settings.baseCurrencyId,
      description: `${returning ? "فرق تكلفة مردود مشتريات" : "تسوية تكلفة المخزون السالب"} ${number}`,
      idempotencyKey: randomUUID(),
      lines: !returning ? (
        variance > 0n ? [
          {
            accountId: settings.inventoryAccountId,
            debit: moneyString(variance), credit: "0",
            description: "تسوية تكلفة مخزون سالب",
          },
          {
            accountId: settings.cogsAccountId,
            debit: "0", credit: moneyString(variance),
            description: "تسوية تكلفة مخزون سالب",
          },
        ] : [
          {
            accountId: settings.cogsAccountId,
            debit: moneyString(-variance), credit: "0",
            description: "تسوية تكلفة مخزون سالب",
          },
          {
            accountId: settings.inventoryAccountId,
            debit: "0", credit: moneyString(-variance),
            description: "تسوية تكلفة مخزون سالب",
          },
        ]
      ) :
        variance > 0n
          ? [
              {
                accountId: settings.inventoryAccountId,
                debit: moneyString(variance),
                credit: "0",
                description: "فرق تكلفة المردود",
              },
              {
                accountId: settings.surplusAccountId,
                debit: "0",
                credit: moneyString(variance),
                description: "فرق تكلفة المردود",
              },
            ]
          : [
              {
                accountId: settings.shortageAccountId,
                debit: moneyString(-variance),
                credit: "0",
                description: "فرق تكلفة المردود",
              },
              {
                accountId: settings.inventoryAccountId,
                debit: "0",
                credit: moneyString(-variance),
                description: "فرق تكلفة المردود",
              },
            ],
    });
  }
  await client.query(
    "UPDATE invoices SET financial_document_id=$1,cost_document_id=$2,variance_document_id=$3,posted=true WHERE company_id=$4 AND id=$5",
    [
      financialDocumentId,
      costDocumentId,
      varianceDocumentId,
      companyId,
      invoiceId,
    ],
  );
  const invoice = await loadInvoice(client, companyId, invoiceId);
  await audit(
    client,
    user,
    "invoice.post",
    "invoice",
    invoiceId,
    null,
    invoice,
    companyId,
  );
  return invoice;
}

import { z } from "zod";
import { amountSchema, documentDateSchema } from "./finance.ts";
import { normalizeDigits } from "./masters.ts";

const id = z.number().int().positive().max(2_147_483_647);
/** Invoice header discount alone accepts negative additional amounts. Financial
 * document debits, credits, item prices and other amounts remain nonnegative. */
export const invoiceDiscountSchema = z.string().trim()
  .transform((value) => normalizeDigits(value).replace(/٫/g, "."))
  .pipe(z.string().regex(
    /^-?\d{1,22}(?:\.\d{1,6})?$/,
    "الخصم مبلغ رقمي موجب أو سالب حتى 22 رقمًا صحيحًا و6 كسور",
  ))
  .transform((value) => value === "-0" ? "0" : value.replace(/^(-?)0+(?=\d)/, "$1"));

export const invoiceKinds = ["sale", "purchase"] as const;
export type InvoiceKind = (typeof invoiceKinds)[number];
export const invoiceKindLabels: Record<InvoiceKind, string> = {
  sale: "فاتورة مبيعات",
  purchase: "فاتورة مشتريات",
};
export const invoiceQuantitySchema = z
  .string()
  .trim()
  .transform(normalizeDigits)
  .pipe(
    z
      .string()
      .regex(
        /^-?\d{1,22}$/,
        "الكمية عدد صحيح غير صفر؛ السالب مردود لهذا الصنف",
      ),
  )
  .transform((value) => BigInt(value).toString())
  .refine((value) => value !== "0", "الكمية لا تساوي صفرًا");
export const invoiceLineSchema = z
  .object({
    itemId: id,
    unit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    quantity: invoiceQuantitySchema,
    /** Free extra units: stock receives them but supplier is not charged. */
    bonusQuantity: z.string().trim().transform(normalizeDigits)
      .pipe(z.string().regex(/^\d{1,22}$/, "البونص عدد صحيح غير سالب"))
      .transform(value => BigInt(value).toString()).optional(),
    unitPrice: amountSchema.optional(),
    expiryDate: documentDateSchema.nullable().default(null),
    originalLineId: id.nullable().default(null),
  })
  .strict();
export const invoiceSchema = z
  .object({
    idempotencyKey: z.uuid(),
    kind: z.enum(invoiceKinds),
    documentDate: documentDateSchema,
    currencyId: id,
    branchId: id,
    locationId: id,
    counterpartyAccountId: id,
    supplierAccountId: id.nullable().default(null),
    doctorId: id.nullable().default(null),
    doctorName: z.string().trim().max(240).default(""),
    saleCustomerNumber: z.string().trim().regex(/^\d{0,30}$/, "رقم العميل يجب أن يكون أرقامًا فقط").default(""),
    saleCustomerName: z.string().trim().max(240).default(""),
    supplierReceiptNumber: z.string().trim().max(100).default(""),
    description: z.string().trim().max(1000).default(""),
    discount: invoiceDiscountSchema.default("0"),
    lines: z.array(invoiceLineSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "purchase" && (value.saleCustomerNumber || value.saleCustomerName))
      context.addIssue({ code: "custom", path: ["saleCustomerNumber"], message: "بيانات كرت العميل مخصصة للمبيعات فقط" });
    if (value.kind === "purchase" && (value.doctorId !== null || value.doctorName))
      context.addIssue({ code: "custom", path: ["doctorId"], message: "اختيار الطبيب أو الجهة مخصص للمبيعات" });
    if (value.kind === "sale" && value.supplierReceiptNumber)
      context.addIssue({ code: "custom", path: ["supplierReceiptNumber"], message: "رقم وصل المورد مخصص للمشتريات فقط" });
    if (value.kind === "sale" && value.supplierAccountId !== null)
      context.addIssue({
        code: "custom",
        path: ["supplierAccountId"],
        message: "المورد المستقل مخصص لفواتير المشتريات فقط",
      });
    if (value.lines.length === 0) return;
    if (value.lines.some((line) => !/^-?\d+$/.test(line.quantity))) return;
    for (const [index, line] of value.lines.entries()) {
      const returning = BigInt(line.quantity) < 0n;
      const bonus = BigInt(line.bonusQuantity ?? "0");
      if (bonus > 0n && (value.kind !== "purchase" || returning || line.originalLineId !== null))
        context.addIssue({code:"custom",path:["lines",index,"bonusQuantity"],message:"البونص مسموح للمشتريات الجديدة الموجبة فقط"});
      if (bonus && BigInt(line.quantity) + bonus > 10n ** 22n - 1n)
        context.addIssue({code:"custom",path:["lines",index,"bonusQuantity"],message:"إجمالي الكمية مع البونص يتجاوز الحد المدعوم"});
      if (!returning && line.originalLineId !== null)
        context.addIssue({
          code: "custom",
          path: ["lines", index, "originalLineId"],
          message: "السطر الموجب لا يرتبط بسطر مردود أصلي",
        });
      if (returning && value.kind === "purchase" && line.originalLineId === null && line.unitPrice === undefined)
        context.addIssue({
          code: "custom",
          path: ["lines", index, "unitPrice"],
          message: "أدخل سعر سطر مردود المشتريات غير المرتبط بأصل",
        });
    }
  });
/** Header-only correction for an already posted sale invoice.
 * Either customer field may be empty. Expected snapshots prevent stale tabs
 * overwriting a change made on another device. No accounting data is edited. */
export const invoiceSaleCustomerPatchSchema = z.object({
  saleCustomerNumber: z.string().trim().regex(/^\d{0,30}$/, "رقم العميل يجب أن يكون أرقامًا فقط حتى 30 رقمًا"),
  saleCustomerName: z.string().trim().max(240),
  expectedSaleCustomerId: id.nullable(),
  expectedSaleCustomerNumber: z.string().nullable(),
  expectedSaleCustomerName: z.string().nullable(),
}).strict();
/** The optional name is part of the invoice snapshot, even without a customer number. */
export function normalizeSaleCustomer<T extends {
  kind:"sale"|"purchase";
  saleCustomerNumber:string;
  saleCustomerName:string;
}>(value:T):T {
  // Keep this helper for existing callers: name-only sales must not be discarded.
  return value;
}
export type InvoiceInput = z.input<typeof invoiceSchema>;
export interface InvoiceLine {
  id: number;
  lineNumber: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  /** Current item-card English name; only used for sales invoice print. */
  itemEnglishName?: string;
  unit: 1 | 2 | 3;
  unitName: string;
  factor2: number;
  factor3: number;
  purchaseFactor: number;
  quantity: string;
  /** Free physical units in this line's selected unit; zero for old invoices. */
  bonusQuantity?: string;
  smallestQuantity: string;
  unitPrice: string;
  gross: string;
  discount: string;
  total: string;
  baseTotal: string;
  costBase: string;
  commissionRate: string;
  commissionAmount: string;
  expiryDate: string | null;
  originalLineId: number | null;
}
export interface Invoice {
  id: number;
  companyId: number;
  number: string;
  kind: InvoiceKind;
  status: "posted";
  returning: boolean;
  mixed: boolean;
  documentDate: string;
  currencyId: number;
  currencyCode: string;
  currencyName: string;
  decimalPlaces: number;
  baseCurrencyId: number;
  baseCurrencyCode: string;
  baseDecimalPlaces: number;
  exchangeRate: string;
  branchId: number;
  branchName: string;
  locationId: number;
  locationName: string;
  counterpartyAccountId: number;
  counterpartyAccountCode: string;
  counterpartyAccountName: string;
  supplierAccountId: number | null;
  supplierAccountCode: string | null;
  supplierAccountName: string | null;
  supplierReceiptNumber: string;
  doctorId: number | null;
  doctorName: string | null;
  saleCustomerId: number | null;
  saleCustomerNumber: string | null;
  saleCustomerName: string | null;
  description: string;
  /** Read-only purchase correction trail; never part of the editable invoice notes. */
  purchaseCorrectionNote?: string;
  gross: string;
  discount: string;
  total: string;
  baseTotal: string;
  financialDocumentId: number | null;
  costDocumentId: number | null;
  varianceDocumentId: number | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  lines: InvoiceLine[];
}
function units(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const magnitude = BigInt(whole) * 1_000_000n +
    BigInt(fraction.padEnd(6, "0"));
  return negative ? -magnitude : magnitude;
}
function amount(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const fraction = (magnitude % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${magnitude / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
/** Unit prices retain at least four decimals; money rounds only after multiplication. */
export function invoiceLineGross(quantity: string, unitPrice: string, decimalPlaces: number): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6)
    throw new Error("دقة العملة غير صالحة");
  const price = units(amountSchema.parse(unitPrice));
  const priceStep = 10n ** BigInt(6 - Math.max(4, decimalPlaces));
  if (price % priceStep !== 0n)
    throw new Error("سعر السطر يقبل حتى أربع خانات عشرية");
  const raw = BigInt(invoiceQuantitySchema.parse(quantity)) * price;
  const step = 10n ** BigInt(6 - decimalPlaces);
  const magnitude = raw < 0n ? -raw : raw;
  const rounded = ((magnitude + step / 2n) / step) * step;
  return amount(raw < 0n ? -rounded : rounded);
}

/** Effective purchase-card price per FIRST unit (4 decimals), using exact
 * invoice-money micros and physical stock in the smallest unit. The free bonus
 * changes only the denominator, never the amount billed to the supplier. */
export function netPurchasePriceFirstUnit(
  netLineTotal: string, netSmallestQuantity: string, smallestPerFirstUnit: number | bigint,
): string {
  const paid = units(netLineTotal);
  const stock = BigInt(netSmallestQuantity);
  const factor = BigInt(smallestPerFirstUnit);
  if (paid < 0n || stock <= 0n || factor <= 0n)
    throw new Error("كمية أو قيمة شراء صافية غير صالحة");
  const numerator = paid * factor;
  const fourDecimals = (numerator + stock * 50n) / (stock * 100n);
  return amount(fourDecimals * 100n);
}

/** Combine duplicate positive receipt lines before recalculating the item-card price.
 * The quantities already include gifts and use the item's smallest stock unit.
 * Net totals include both line and invoice-level discounts.
 */
export function groupPurchaseReceiptPrices(
  lines: readonly { itemId: number; quantitySmallest: string; netTotal: string }[],
): { itemId: number; quantitySmallest: string; netTotal: string }[] {
  const grouped = new Map<number, { quantity: bigint; net: bigint }>();
  for (const line of lines) {
    const quantity = BigInt(line.quantitySmallest);
    const net = units(line.netTotal);
    if (quantity <= 0n || net < 0n)
      throw new Error("كمية أو صافي مشتريات غير صالح لحساب المتوسط");
    const existing = grouped.get(line.itemId);
    if (existing) {
      existing.quantity += quantity;
      existing.net += net;
    } else grouped.set(line.itemId, { quantity, net });
  }
  return [...grouped.entries()].map(([itemId, value]) => ({
    itemId,
    quantitySmallest: value.quantity.toString(),
    netTotal: amount(value.net),
  }));
}

/** Weighted item-card purchase price, in the item's currency, per FIRST unit.
 * Value the existing stock at its previous card price. Add all new purchases at
 * their net billed value, with any free bonus included only in stock quantity.
 * All math is exact bigint and rounded once to four price decimals.
 */
export function weightedPurchasePriceFirstUnit(
  previousPrice: string,
  previousQuantitySmallest: string,
  purchaseNetTotal: string,
  incomingQuantitySmallest: string,
  smallestPerFirstUnit: number | bigint,
): string {
  const priorQuantity = BigInt(previousQuantitySmallest);
  const incomingQuantity = BigInt(incomingQuantitySmallest);
  const factor = BigInt(smallestPerFirstUnit);
  const priorPrice = units(amountSchema.parse(previousPrice));
  const purchasedNet = units(purchaseNetTotal);
  if (priorQuantity < 0n || incomingQuantity <= 0n || factor <= 0n ||
      priorPrice < 0n || purchasedNet < 0n)
    throw new Error("سعر أو كمية غير صالح لحساب متوسط الشراء");
  const totalQuantity = priorQuantity + incomingQuantity;
  const valueNumerator = priorQuantity * priorPrice + purchasedNet * factor;
  const fourDecimals = (valueNumerator + totalQuantity * 50n) / (totalQuantity * 100n);
  return amount(fourDecimals * 100n);
}

/** Distribute the entered header discount according to the gross invoice sign.
 * A net-negative invoice applies the new amount to returning lines; the
 * inherited discount of a linked return is kept separately and never replaced.
 * The optional `discount` on a negative line is the existing inherited
 * reversal, not the user-entered extra header amount.
 */
export function calculateInvoiceTotals(
  lines: { quantity: string; unitPrice: string; discount?: string }[],
  discount: string,
  decimalPlaces: number,
) {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6)
    throw new Error("دقة العملة غير صالحة");
  const step = 10n ** BigInt(6 - decimalPlaces);
  const quantities = lines.map(line => BigInt(invoiceQuantitySchema.parse(line.quantity)));
  const grossLines = lines.map((line,index) => {
    return units(invoiceLineGross(line.quantity, line.unitPrice, decimalPlaces));
  });
  const gross = grossLines.reduce((sum,value)=>sum+value,0n);
  const inherited = lines.map((line,index) => {
    if (quantities[index] >= 0n || line.discount === undefined) return 0n;
    const text = normalizeDigits(line.discount.trim()).replace(/٫/g,".");
    const inheritedValue = units(invoiceDiscountSchema.parse(text));
    if (inheritedValue < grossLines[index] || inheritedValue % step !== 0n)
      throw new Error("خصم المردود غير مطابق لقيمة السطر أو دقة العملة");
    return inheritedValue;
  });
  const discountUnits = units(invoiceDiscountSchema.parse(discount));
  if (discountUnits % step !== 0n)
    throw new Error("الخصم يتجاوز دقة العملة");
  if (gross === 0n && discountUnits !== 0n)
    throw new Error("لا يُطبَّق خصم إضافي على فاتورة إجماليها صفر");
  const applyToReturns = gross < 0n;
  const candidates = grossLines.map((value,index) =>
    applyToReturns ? value < 0n : value > 0n);
  // Positive discount on positive sales must not exceed their gross.
  // Negative discount on a refund must not reverse the refund into a sale.
  const capacities = grossLines.map((value,index) =>
    !candidates[index] ? 0n : applyToReturns
      ? -(value - inherited[index])
      : value);
  const maxReduction = capacities.reduce((sum,value)=>sum+value,0n);
  if ((!applyToReturns && discountUnits > maxReduction) ||
      (applyToReturns && discountUnits < -maxReduction))
    throw new Error("قيمة الخصم تتجاوز المبلغ المتاح للفواتير أو المردود");
  const magnitude = discountUnits < 0n ? -discountUnits : discountUnits;
  const limited = applyToReturns ? discountUnits < 0n : discountUnits > 0n;
  const weights = grossLines.map((value,index) =>
    !candidates[index] ? 0n : limited ? capacities[index] :
      value < 0n ? -value : value);
  const weightTotal = weights.reduce((sum,value)=>sum+value,0n);
  if (magnitude > 0n && weightTotal <= 0n)
    throw new Error("لا يوجد سطر صالح لتوزيع الخصم");
  const manualParts = weights.map(value =>
    value === 0n ? 0n : ((magnitude * value) / weightTotal / step) * step);
  let remaining = magnitude - manualParts.reduce((sum,value)=>sum+value,0n);
  for (let index=0; remaining>0n && index<manualParts.length; index++) {
    if (weights[index] && (!limited || manualParts[index] + step <= capacities[index])) {
      manualParts[index] += step;
      remaining -= step;
    }
  }
  if (remaining!==0n) throw new Error("تعذر توزيع الخصم دون تجاوز قيمة السطور");
  const manual = manualParts.map(value=>discountUnits<0n ? -value : value);
  const shares = manual.map((value,index)=>value+inherited[index]);
  const totalDiscount = shares.reduce((sum,value)=>sum+value,0n);
  return {
    gross: amount(gross),
    discount: amount(totalDiscount),
    total: amount(gross-totalDiscount),
    lineDiscounts: shares.map(amount),
    // Store the explicitly entered share independently from linked-return
    // prorated discounts to keep historical refund limits intact.
    lineManualDiscounts: manual.map(amount),
    lineTotals: grossLines.map((value,index)=>amount(value-shares[index])),
  };
}
export const commerceCatalog = { invoiceKinds, invoiceKindLabels };

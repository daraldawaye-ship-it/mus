import { z } from "zod";
import { amountSchema, documentDateSchema } from "./finance.ts";
import { normalizeDigits } from "./masters.ts";

const id = z.number().int().positive().max(2_147_483_647);
export const invoiceKinds = ["sale", "purchase"] as const;
export type InvoiceKind = (typeof invoiceKinds)[number];
export const invoiceKindLabels: Record<InvoiceKind, string> = { sale: "فاتورة مبيعات", purchase: "فاتورة مشتريات" };
export const invoiceQuantitySchema = z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^-?\d{1,22}$/, "الكمية عدد صحيح غير صفر؛ السالب مردود مرتبط بالأصل")).transform((value) => BigInt(value).toString()).refine((value) => value !== "0", "الكمية لا تساوي صفرًا");
export const invoiceLineSchema = z.object({
  itemId: id,
  unit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  quantity: invoiceQuantitySchema,
  unitPrice: amountSchema.optional(),
  expiryDate: documentDateSchema.nullable().default(null),
  originalLineId: id.nullable().default(null),
}).strict();
export const invoiceSchema = z.object({
  idempotencyKey: z.uuid(),
  kind: z.enum(invoiceKinds),
  documentDate: documentDateSchema,
  currencyId: id,
  branchId: id,
  locationId: id,
  counterpartyAccountId: id,
  description: z.string().trim().max(1000).default(""),
  discount: amountSchema.default("0"),
  lines: z.array(invoiceLineSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.lines.length === 0) return;
  const returning = BigInt(value.lines[0].quantity) < 0n;
  for (const [index, line] of value.lines.entries()) {
    if ((BigInt(line.quantity) < 0n) !== returning)
      context.addIssue({ code: "custom", path: ["lines", index, "quantity"], message: "الفاتورة تحوي بيعًا/شراءً أو مردودًا فقط؛ لا تجمع الاتجاهين" });
    if (returning !== (line.originalLineId !== null))
      context.addIssue({ code: "custom", path: ["lines", index, "originalLineId"], message: "المردود يحتاج سطر الأصل؛ السطر الموجب لا يرتبط بمردود" });
  }
  if (returning && value.discount !== "0") context.addIssue({ code: "custom", path: ["discount"], message: "خصم المردود يحسب من الأصل تلقائيًا" });
});
export type InvoiceInput = z.input<typeof invoiceSchema>;
export interface InvoiceLine {
  id: number; lineNumber: number; itemId: number; itemCode: string; itemName: string;
  unit: 1 | 2 | 3; unitName: string; factor2: number; factor3: number; purchaseFactor: number;
  quantity: string; smallestQuantity: string; unitPrice: string; gross: string; discount: string;
  total: string; baseTotal: string; costBase: string; expiryDate: string | null; originalLineId: number | null;
}
export interface Invoice {
  id: number; companyId: number; number: string; kind: InvoiceKind; status: "posted";
  documentDate: string; currencyId: number; currencyCode: string; currencyName: string; decimalPlaces: number;
  baseCurrencyId: number; baseCurrencyCode: string; baseDecimalPlaces: number; exchangeRate: string;
  branchId: number; branchName: string; locationId: number; locationName: string;
  counterpartyAccountId: number; counterpartyAccountCode: string; counterpartyAccountName: string;
  description: string; gross: string; discount: string; total: string; baseTotal: string;
  financialDocumentId: number; costDocumentId: number | null; varianceDocumentId: number | null;
  createdBy: number; createdByName: string; createdAt: string; lines: InvoiceLine[];
}
function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function amount(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
/** Exact absolute document discount apportioned in currency minor units, stable line order. */
export function calculateInvoiceTotals(lines: { quantity: string; unitPrice: string }[], discount: string, decimalPlaces: number) {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error("دقة العملة غير صالحة");
  const step = 10n ** BigInt(6 - decimalPlaces);
  const grossLines = lines.map((line) => {
    const quantity = invoiceQuantitySchema.parse(line.quantity);
    const price = units(amountSchema.parse(line.unitPrice));
    if (price % step !== 0n) throw new Error("سعر السطر يتجاوز دقة العملة");
    return (BigInt(quantity) < 0n ? -BigInt(quantity) : BigInt(quantity)) * price;
  });
  const gross = grossLines.reduce((sum, value) => sum + value, 0n);
  const discountUnits = units(amountSchema.parse(discount));
  if (discountUnits % step !== 0n || discountUnits > gross) throw new Error("الخصم يتجاوز الإجمالي أو دقة العملة");
  const shares = grossLines.map((value) => gross === 0n ? 0n : (discountUnits * value / gross / step) * step);
  let remaining = discountUnits - shares.reduce((sum, value) => sum + value, 0n);
  for (let index = 0; remaining > 0n && index < shares.length; index++) {
    if (shares[index] + step <= grossLines[index]) { shares[index] += step; remaining -= step; }
  }
  if (remaining !== 0n) throw new Error("تعذر توزيع الخصم");
  return { gross: amount(gross), discount: amount(discountUnits), total: amount(gross - discountUnits), lineDiscounts: shares.map(amount), lineTotals: grossLines.map((value, index) => amount(value - shares[index])) };
}
export const commerceCatalog = { invoiceKinds, invoiceKindLabels };

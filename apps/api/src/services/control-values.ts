import type { Database } from "../db.ts";
import { HttpError } from "../errors.ts";
import { controlByKey } from "./control-catalog.ts";

/** Effective server-side value. There is no write-through to the catalog. */
export async function controlValue(
  db: Database, companyId: number, key: string, employeeId: number | null = null,
): Promise<boolean | number> {
  const option = controlByKey(key);
  if (!option) throw new Error("Unknown control: " + key);
  const subject = option.scope === "company" ? null : employeeId;
  if (option.scope === "employee" && !subject) return option.defaultValue;
  const row = (await db.query(
    "SELECT value FROM company_control_values WHERE company_id=$1 AND control_key=$2 AND employee_id IS NOT DISTINCT FROM $3::integer",
    [companyId, key, subject],
  )).rows[0];
  return row?.value ?? option.defaultValue;
}
export async function adenToday(db: Database): Promise<string> {
  const result = await db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today");
  return result.rows[0].today as string;
}
export async function assertEditableDocumentDate(
  db: Database, companyId: number, key: string, requested: string, previous?: string,
) {
  if (await controlValue(db, companyId, key)) return;
  if (previous !== undefined ? requested === previous : requested === await adenToday(db)) return;
  throw new HttpError(403, "control_date_disabled", "الكنترول يمنع تعديل تاريخ هذا المستند.");
}
export function requestLooksMobile(userAgent: string | undefined): boolean {
  return /android|iphone|ipad|ipod|mobile|windows phone/i.test(userAgent ?? "");
}
export async function assertMobileInvoiceCreation(
  db: Database, companyId: number, kind: "sale" | "purchase", userAgent?: string,
) {
  if (!requestLooksMobile(userAgent)) return;
  const key = kind === "sale" ? "mobile_sales" : "mobile_purchases";
  if (await controlValue(db, companyId, key)) return;
  throw new HttpError(403, "control_mobile_disabled", "الكنترول يمنع إنشاء هذا النوع من الفواتير من الهاتف.");
}
export async function assertYerWhenCurrencyHidden(
  db: Database, companyId: number, currencyId: number,
) {
  if (await controlValue(db, companyId, "show_currency")) return;
  const row = (await db.query(
    "SELECT 1 FROM company_currencies WHERE company_id=$1 AND id=$2 AND code='YER' AND active",
    [companyId, currencyId],
  )).rows[0];
  if (!row) throw new HttpError(403, "control_currency_hidden", "العملة مخفية في الكنترول؛ استخدم الريال اليمني.");
}
export async function attendanceAutoHours(db: Database, companyId: number): Promise<number> {
  const value = await controlValue(db, companyId, "auto_checkout_hours");
  return typeof value === "number" ? value : 16;
}

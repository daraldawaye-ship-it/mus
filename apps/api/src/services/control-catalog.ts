/** Server-owned control catalog. Add keys here; never let clients invent keys or values. */
export type ControlScope = "company" | "employee";
export type ControlOption = {
  key: string;
  label: string;
  category: string;
  scope: ControlScope;
  type: "boolean" | "hours" | "number";
  defaultValue: boolean | number;
  min?: number;
  max?: number;
  accountantDefault?: boolean;
  description?: string;
  /** First increment persists policy; operational consumers are integrated separately. */
  integrated: boolean;
};
export const controlCatalog: readonly ControlOption[] = [
  { key: "show_currency", label: "إظهار العملة في الفواتير والسندات", category: "الفواتير والسندات", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_sales_date", label: "السماح بتعديل تاريخ فاتورة المبيعات", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_purchases_date", label: "السماح بتعديل تاريخ فاتورة المشتريات", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_receipts_date", label: "السماح بتعديل تاريخ سند القبض", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_payments_date", label: "السماح بتعديل تاريخ سند الصرف", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_journals_date", label: "السماح بتعديل تاريخ القيد", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "mobile_sales", label: "السماح بإنشاء فواتير المبيعات من الهاتف", category: "الأجهزة", scope: "company", type: "boolean", defaultValue: true, integrated: true },
  { key: "mobile_purchases", label: "السماح بإنشاء فواتير المشتريات من الهاتف", category: "الأجهزة", scope: "company", type: "boolean", defaultValue: true, integrated: true },
  { key: "auto_checkout_hours", label: "عدد ساعات الانصراف التلقائي", category: "الدوام", scope: "company", type: "hours", defaultValue: 16, min: 1, max: 48, integrated: true },
  { key: "show_shortcuts_menu", label: "إظهار اختصار إلى في قائمة المستخدم", category: "الموظف", scope: "employee", type: "boolean", defaultValue: true, integrated: true, description: "إظهار الاختصارات الشخصية للصفحات المسموح بها، مع إدارتها لكل مستخدم." },
  { key: "show_header_points", label: "عرض مبلغ النقاط أعلى الشاشة", category: "الموظف", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
  { key: "idle_logout_hours", label: "تسجيل الخروج بعد السكون (ساعة؛ صفر للتعطيل)", category: "الموظف", scope: "employee", type: "hours", defaultValue: 0, min: 0, max: 72, integrated: true },
  { key: "show_recent_item_purchases", label: "إظهار خيارات الصنف في فاتورة المشتريات", category: "الفواتير والسندات", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
  { key: "sales_doctor_threshold", label: "قيمة فاتورة المبيعات التي تستلزم اختيار الطبيب أو الجهة", category: "الفواتير والسندات", scope: "company", type: "number", defaultValue: 1000, min: 0, max: 999999999, accountantDefault: true, integrated: true, description: "إذا تجاوز صافي المبيعات القيمة موجبة أو سالبة، يُلزم اختيار طبيب أو ممرض أو جهة فعالة." },
  { key: "show_item_options_sales", label: "إظهار خيارات الصنف في فاتورة المبيعات", category: "الفواتير والسندات", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
];
export function controlByKey(key: string): ControlOption | undefined {
  return controlCatalog.find((option) => option.key === key);
}
export function validControlValue(option: ControlOption, value: unknown): value is boolean | number {
  if (option.type === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= (option.min ?? 0) && value <= (option.max ?? (option.type === "hours" ? 72 : 999999999));
}

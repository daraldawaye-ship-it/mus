import { accountChoices, type AccountChoice } from "../../../../packages/contracts/src/masters.ts";
/** Server-owned control catalog. Add keys here; never let clients invent keys or values. */
export type ControlScope = "company" | "employee";
export type ControlOption = {
  key: string;
  label: string;
  category: string;
  scope: ControlScope;
  type: "boolean" | "hours" | "number" | "multi_choice" | "account";
  defaultValue: boolean | number | AccountChoice[];
  choices?: readonly AccountChoice[];
  min?: number;
  max?: number;
  accountantDefault?: boolean;
  description?: string;
  /** First increment persists policy; operational consumers are integrated separately. */
  integrated: boolean;
};
export const controlCatalog: readonly ControlOption[] = [
  { key:"purchase_receipt_required_choices", label:"أنواع الحسابات التي يلزم معها رقم الوصل في المشتريات", category:"المشتريات", scope:"company", type:"multi_choice", defaultValue:[], choices:accountChoices, accountantDefault:true, integrated:true, description:"اختر أنواع الحسابات مثل جملة، شركة، صيدلية. تُطبّق الإلزامية على حساب رأس الفاتورة، وليس المورد الفعلي." },
  { key:"purchase_default_account", label:"الحساب الافتراضي لرأس فاتورة المشتريات", category:"المشتريات", scope:"company", type:"account", defaultValue:0, min:0, accountantDefault:true, integrated:true, description:"حساب السداد أو الذمة في رأس الفاتورة، وليس المورد الفعلي. صفر يعني بدون حساب افتراضي." },
  { key: "show_currency", label: "إظهار العملة في الفواتير والسندات", category: "الفواتير والسندات", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "show_voucher_branch", label: "إظهار حقل الفرع في سندات القبض والصرف", category: "الفواتير والسندات", scope: "company", type: "boolean", defaultValue: false, accountantDefault: true, integrated: true, description: "الفرع مخفي افتراضيًا؛ يمكن إظهاره من الكنترول دون تغيير الفرع المسجل في السندات السابقة." },
  { key: "edit_sales_date", label: "السماح بتعديل تاريخ فاتورة المبيعات", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_purchases_date", label: "السماح بتعديل تاريخ فاتورة المشتريات", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_receipts_date", label: "السماح بتعديل تاريخ سند القبض", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_payments_date", label: "السماح بتعديل تاريخ سند الصرف", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "edit_journals_date", label: "السماح بتعديل تاريخ القيد", category: "التواريخ", scope: "company", type: "boolean", defaultValue: true, accountantDefault: true, integrated: true },
  { key: "mobile_sales", label: "السماح بإنشاء فواتير المبيعات من الهاتف", category: "الأجهزة", scope: "company", type: "boolean", defaultValue: true, integrated: true },
  { key: "mobile_purchases", label: "السماح بإنشاء فواتير المشتريات من الهاتف", category: "الأجهزة", scope: "company", type: "boolean", defaultValue: true, integrated: true },
  { key: "auto_checkout_hours", label: "عدد ساعات الانصراف التلقائي", category: "الدوام", scope: "company", type: "hours", defaultValue: 16, min: 1, max: 48, integrated: true },
  { key: "inventory_count_importance", label: "مستوى أهمية الجرد", category: "الأصناف والمخزون", scope: "company", type: "number", defaultValue: 8, min: 1, max: 1000, integrated: true, description: "يحدد قيمة البسط في معادلة «الجرد لا يزيد عن»: المستوى ÷ (مرات البيع في آخر شهر + 5) ÷ 30." },
  { key: "show_shortcuts_menu", label: "إظهار اختصار إلى في قائمة المستخدم", category: "الموظف", scope: "employee", type: "boolean", defaultValue: true, integrated: true, description: "إظهار الاختصارات الشخصية للصفحات المسموح بها، مع إدارتها لكل مستخدم." },
  { key: "show_header_points", label: "عرض مبلغ النقاط أعلى الشاشة", category: "الموظف", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
  { key: "idle_logout_hours", label: "تسجيل الخروج بعد السكون (ساعة؛ صفر للتعطيل)", category: "الموظف", scope: "employee", type: "hours", defaultValue: 0, min: 0, max: 72, integrated: true },
  { key: "show_recent_item_purchases", label: "إظهار خيارات الصنف في فاتورة المشتريات", category: "الفواتير والسندات", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
  { key: "sales_doctor_threshold", label: "قيمة فاتورة المبيعات التي تستلزم اختيار الطبيب أو الجهة", category: "الفواتير والسندات", scope: "company", type: "number", defaultValue: 1000, min: 0, max: 999999999, accountantDefault: true, integrated: true, description: "إذا تجاوز صافي المبيعات القيمة موجبة أو سالبة، يُلزم اختيار طبيب أو ممرض أو جهة فعالة." },
  { key: "sales_near_expiry_months", label: "عدد الأشهر للتنبيه عن اقتراب انتهاء بدائل الصنف", category: "الفواتير والسندات", scope: "company", type: "number", defaultValue: 3, min: 0, max: 24, integrated: true, description: "الافتراضي ثلاثة أشهر؛ صفر يعطل تنبيه قرب الانتهاء، ولا يغيّر المخزون أو تاريخ الانتهاء." },
  { key: "show_item_options_sales", label: "إظهار خيارات الصنف في فاتورة المبيعات", category: "الفواتير والسندات", scope: "employee", type: "boolean", defaultValue: true, integrated: true },
];
export function controlByKey(key: string): ControlOption | undefined {
  return controlCatalog.find((option) => option.key === key);
}
export function validControlValue(option: ControlOption, value: unknown): value is boolean | number | AccountChoice[] {
  if (option.type === "boolean") return typeof value === "boolean";
  if (option.type === "multi_choice") return Array.isArray(value) && value.length <= accountChoices.length && new Set(value).size === value.length && value.every(v => typeof v === "string" && accountChoices.includes(v as AccountChoice));
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= (option.min ?? 0) && value <= (option.max ?? (option.type === "hours" ? 72 : 999999999));
}

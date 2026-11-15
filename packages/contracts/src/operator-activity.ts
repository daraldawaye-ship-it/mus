// Stable analytics keys; never include DOM text, URLs, or typed values.
export const avatarActivityActionKeys = [
  "avatar.open", "navigation.open", "item.open", "financial_account.open",
  "employee.open", "tools.open", "settings.open", "shortcut.open", "entity.open",
  "quick_add.open", "quick_add.select", "profile.open", "appearance.open",
  "connections.open", "logout", "refresh",
] as const;
export const operatorActivityDetailLabels: Readonly<Record<string, string>> = {
  "menu.edit_shortcuts": "تحديد اختصاراتي", "menu.add_general": "إضافة إلى الجدول العام",
  "menu.quick.system_change": "طلب تعديل النظام", "menu.quick.present_employees": "رسالة للمحضّرين",
  "menu.quick.all_employees": "رسالة للموظفين", "menu.quick.app_manager": "رسالة لمسؤول التطبيق",
  "menu.quick.private_note": "مذكرة خاصة", "menu.choose.item": "اختيار صنف",
  "menu.choose.account": "اختيار حساب", "menu.choose.employee": "اختيار مستخدم",
  "menu.previous": "السابق", "menu.next": "التالي",
  "menu.item.movement": "حركة الصنف", "menu.item.purchase": "مشتريات الصنف",
  "menu.item.sale": "مبيعات الصنف", "menu.item.adjustment": "تسويات الصنف",
  "menu.item.transfer": "مناقلات الصنف", "menu.item.alternatives": "البدائل",
  "menu.item.card": "كرت الصنف", "menu.item.memo": "مذكرة بالصنف",
  "menu.item.memo-return": "مذكرة مرتجع",
};
export const operatorSearchActionKeys = [
  "items.search", "market.search", "lists.search",
] as const;
export const operatorActivityPageKeys = [
  "public.home", "public.companies", "public.chat", "public.notifications",
  "public.profile", "public.tasks", "public.medicine_market", "public.legal_cases",
  "public.general_table", "public.other", "company.overview", "company.chat",
  "company.notifications", "company.items", "company.accounts", "company.employees",
  "company.attendance", "company.invoice", "company.inventory", "company.other",
] as const;
export type OperatorActivityPageKey = typeof operatorActivityPageKeys[number];
export type OperatorSearchActionKey = typeof operatorSearchActionKeys[number];
export function isOperatorSearchAllowed(action: OperatorSearchActionKey, page: OperatorActivityPageKey): boolean {
  return (action === "items.search" && (page === "company.items" || page === "company.overview"))
    || (action === "market.search" && page === "public.medicine_market")
    || (action === "lists.search" && page === "company.inventory");
}

export function normalizeOperatorSearchText(value: string): string | null {
  // Catalog keywords only. No punctuation other than a hyphen, digits,
  // credentials, phone/email, or raw control characters.
  const normalized = value.normalize("NFKC").trim().replace(/ +/g, " ");
  if (normalized.length > 64 || !/^[\p{L}\p{M} -]+$/u.test(normalized)
      || (normalized.match(/\p{L}/gu)?.length ?? 0) < 3) return null;
  if (/(?:password|passcode|secret|token|bearer|كلمة\s*المرور|رمز\s*التحقق|الرقم\s*السري)/iu.test(normalized)) return null;
  return normalized;
}

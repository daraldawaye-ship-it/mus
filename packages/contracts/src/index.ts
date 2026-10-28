import { z } from "zod";
import { employeePositionListSchema, type EmployeePosition } from "./employee-positions.ts";
export * from "./employee-positions.ts";
import { masterCatalog } from "./masters.ts";
import { financeCatalog } from "./finance.ts";
import { itemCatalog } from "./items.ts";
import { commerceCatalog } from "./commerce.ts";
import { inventoryCatalog } from "./inventory.ts";
export const MAX_ID = 2_147_483_647;

export const userKinds = ["admin", "supervisor", "member"] as const;
export const employeeRoles = [
  "employee",
  "administrative",
  "accountant",
  "sales",
  "purchases",
] as const;
export const permissionKeys = [
  "pages.manage",
  "company.edit",
  "employees.view",
  "audit.view",
  "accounts.view",
  "accounts.manage",
  "accounts.balance-followup",
  "accounts.balance-approve",
  "currencies.view",
  "currencies.manage",
  "locations.view",
  "locations.manage",
  "finance.view",
  "finance.own-cashbox.view",
  "finance.manage",
  "finance.post",
  "items.view",
  "items.manage",
  "commerce.view",
  "commerce.manage",
  "inventory.view",
  "inventory.manage",
  "inventory.post",
] as const;
export type UserKind = (typeof userKinds)[number];
export type EmployeeRole = (typeof employeeRoles)[number];
export type Permission = (typeof permissionKeys)[number];
export const userKindLabels: Record<UserKind, string> = {
  admin: "إدارة",
  supervisor: "مشرف",
  member: "عضو",
};
export const employeeRoleLabels: Record<EmployeeRole, string> = {
  employee: "موظف",
  administrative: "إداري",
  accountant: "محاسب",
  sales: "مبيعات",
  purchases: "مشتريات",
};
export const permissionLabels: Record<Permission, string> = {
  "pages.manage": "إدارة إظهار وتفعيل صفحات الشركة",
  "company.edit": "تعديل بيانات الشركة",
  "employees.view": "عرض الموظفين",
  "audit.view": "عرض سجل الشركة",
  "accounts.view": "عرض دليل الحسابات",
  "accounts.manage": "إدارة دليل الحسابات",
  "accounts.balance-followup": "تسجيل متابعة رصيد الحساب",
  "accounts.balance-approve": "اعتماد رصيد الحساب",
  "currencies.view": "عرض العملات وأسعار الصرف",
  "currencies.manage": "إدارة العملات وأسعار الصرف",
  "locations.view": "عرض الفروع والمواقع",
  "locations.manage": "إدارة الفروع والمواقع",
  "finance.view": "عرض القيود والسندات والأرصدة",
  "finance.own-cashbox.view": "عرض كشف حساب صندوقي (تُمنح تلقائيًا لصفة أمين صندوق)",
  "finance.manage": "إنشاء وتعديل المسودات المالية",
  "finance.post": "ترحيل وعكس القيود والسندات",
  "items.view": "عرض الأصناف ووكلائها",
  "items.manage": "إدارة الأصناف ووكلائها",
  "commerce.view": "عرض فواتير المبيعات والمشتريات",
  "commerce.manage": "حفظ وترحيل الفواتير والمردودات",
  "inventory.view": "عرض المخزون وحركاته",
  "inventory.manage": "إدارة إعدادات المخزون",
  "inventory.post": "ترحيل المناقلات والجرد",
};
export const rolePermissionTemplates: Record<EmployeeRole, Permission[]> = {
  employee: [],
  administrative: [
    "company.edit",
    "employees.view",
    "audit.view",
    "accounts.view",
    "currencies.view",
    "locations.manage",
  ],
  accountant: [
    "audit.view",
    "accounts.manage",
    "currencies.manage",
    "locations.view",
    "finance.manage",
    "finance.post",
  ],
  sales: [],
  purchases: [],
};
export const auditActionLabels = {
  "chat.group.create": "إنشاء مجموعة دردشة خاصة",
  "chat.group.update": "تعديل إدارة أو أعضاء مجموعة دردشة",
  "chat.group.leave": "مغادرة مجموعة دردشة",
  "chat.group.send": "إرسال رسالة مجموعة دردشة",
  "chat.group.receipt": "تأكيد استلام أو عرض رسالة مجموعة",
  "chat.send": "إرسال رسالة دردشة خاصة",
  "chat.receipt": "تأكيد استلام أو عرض رسالة دردشة",
  "chat.image.settings": "تعديل إعدادات إرفاق صور الدردشة",
  "owner.create": "إنشاء مالك المنصة",
  "user.register": "إنشاء حساب عام",
  "auth.login": "تسجيل الدخول",
  "auth.logout": "تسجيل الخروج",
  "auth.password": "تغيير كلمة المرور",
  "user.profile": "تعديل الملف الشخصي",
  "media.upload": "رفع صورة",
  "user.update": "تعديل صلاحيات الحساب",
  "appearance.update": "حفظ المظهر",
  "users.view": "عرض المستخدمين",
  "audit.view": "عرض سجل التدقيق",
  "company.create": "إنشاء شركة",
  "company.update": "تعديل بيانات الشركة",
  "company.letterhead.update": "تعديل ترويسة طباعة الشركة",
  "company.transactions.reset": "حذف الحركة المالية والمخزنية للشركة",
  "company.transactions.import": "ترحيل الحركة من النظام السابق",
  "company.transactions.bulk-start": "بدء الترحيل الجماعي للفواتير",
  "company.transactions.bulk-action": "إدارة مهمة الترحيل الجماعي",
  "company.transactions.bulk-complete": "إكمال حسابات الترحيل الجماعي",
  "company.transactions.sourceDates": "تصحيح تواريخ الحركة المستوردة إلى تواريخ المصدر",
  "company.view": "دخول صفحة الشركة",
  "company.activate": "اختيار الشركة",
  "company.lastFallback": "إعادة التحقق من آخر شركة",
  "employee.create": "إضافة موظف",
  "employee.update": "تعديل الموظف",
  "manager.appoint": "تعيين مدير عام",
  "manager.remove": "سحب صفة مدير عام",
  "manager.userArchived": "أرشفة حساب مدير عام من المالك",
  "account.create": "إنشاء حساب",
  "account.update": "تعديل حساب",
  "accountBalance.followup": "تسجيل متابعة رصيد الحساب",
  "accountBalance.approve": "اعتماد رصيد الحساب",
  "accounts.initialize": "تهيئة دليل الحسابات",
  "accountLink.update": "تعديل ربط حساب نظامي",
  "currency.create": "إنشاء عملة",
  "currency.update": "تعديل عملة",
  "currencies.initialize": "تهيئة العملات",
  "financeSettings.update": "تعديل العملة الأساسية",
  "exchangeRate.create": "تسجيل سعر صرف",
  "exchangeRate.update": "تعديل تفعيل سعر صرف",
  "branch.create": "إنشاء فرع",
  "branch.update": "تعديل فرع",
  "location.create": "إنشاء موقع",
  "location.update": "تعديل موقع",
  "legal.create": "إنشاء قضية أو سجل قانوني",
  "legal.update": "تعديل قضية أو سجل قانوني",
  "legal.link": "ربط قضية أو مستند أو واقعة",
  "legal.access": "تعديل صلاحيات القضايا",
  "legal.task.comment": "إضافة تعليق متابعة لمهمة قانونية",
  "archive.create": "إضافة ملف إلى أرشيف المستندات",
  "archive.update": "تعديل وصف واستدلال مستند",
  "archive.category": "تحديد فئة الأرشيف للقضايا",
  "generalTable.create": "إضافة سجل عام",
  "generalTable.duplicate": "تكرار سجلات الجدول العام",
  "generalTable.update": "تعديل سجل عام",
  "financialDocument.create": "إنشاء مسودة مالية",
  "financialDocument.update": "تعديل مسودة مالية",
  "financialDocument.post": "ترحيل مستند مالي",
  "cashbox.quick-post": "ترحيل سريع لصندوق مبيعات الموظف",
  "pouch.received": "استلام وترحيل حركة الحافظة إلى صندوق المستلم",
  "electronic.received": "استلام وترحيل حركة المحفظة الإلكترونية إلى صندوق المستلم",
  "financialDocument.reverse": "عكس مستند مالي",
  "doctor.create": "إضافة طبيب أو جهة",
  "doctor.update": "تعديل كرت طبيب أو جهة",
  "itemAgent.create": "إضافة وكيل صنف",
  "itemAgent.update": "تعديل وكيل صنف",
  "itemComposition.create": "إضافة تركيب صنف",
  "itemComposition.update": "تعديل تركيب صنف",
  "itemShelf.update": "تعديل كرت رف",
  "item.create": "إضافة صنف",
  "item.update": "تعديل صنف",
  "clearance.earn": "إثبات عمولة تصريف للموظف",
  "clearance.wallet-credit": "ترحيل عمولة التصريف إلى رصيد المحفظة",
  "clearance.return-queue": "إحالة مرتجع تصريف لمراجعة الإدارة",
  "clearance.return-reviewed": "مراجعة الإدارة لمرتجع التصريف",
  "item.field.update": "تعديل حقل في كرت الصنف",
  "invoice.post": "حفظ وترحيل فاتورة",
  "memo.feature-rule": "تعديل قاعدة متابعة المذكرات",
  "memo.feature-trigger": "تحقق قاعدة ميزات مرتبطة بالمذكرات",
  "inventory.settings": "حفظ إعدادات المخزون",
  "notification.create": "إنشاء تنبيه آلي",
  "notification.follow": "متابعة تنبيه",
  "notification.assign": "إسناد متابعة تنبيه",
  "notification.remind": "تكرار تنبيه",
  "notification.settings": "إعداد نوع تنبيه",
  "question.create": "إنشاء سؤال",
  "question.update": "تعديل سؤال",
  "question.answer": "الإجابة عن سؤال",
  "memo.create": "إنشاء مذكرة",
  "memo.read": "قراءة مذكرة",
  "memo.reply": "رد على مذكرة",
  "memo.return": "إعادة مذكرة للمرسل",
  "memo.forward": "تحويل مذكرة",
  "memo.request-completion": "طلب اعتماد إنجاز مذكرة",
  "memo.approve-completion": "اعتماد إنجاز مذكرة",
  "memo.reopen-completion": "إعادة مذكرة للاستكمال",
  "memo.complete": "إنجاز مذكرة لدى مرسلها",
  "memo.links": "تعديل روابط ومراجع المذكرة",
  "memo.options": "تعديل خصائص المذكرة",
  "memo.schedule": "تأجيل متابعة المذكرة",
  "memo.reminder-settings": "إعدادات تذكير المذكرات",
  "memo.followers": "تعديل المتابعين وصلاحياتهم",
  "memo.follower-comment": "إضافة تعليق متابعة",
  "wallet.award": "إضافة نقاط إدارية",
  "wallet.deduct": "خصم نقاط إداري",
  "wallet.auto-award": "احتساب مكافأة آلية",
  "wallet.reverse": "تصحيح حركة نقاط",
  "wallet.task": "إعداد مهمة مكافأة",
  "automaticTask.settings": "تعديل كنترول مهمة آلية",
  "wallet.policy": "إعداد سياسة تحويل النقاط",
  "wallet.account": "ربط حساب محفظة الموظف",
  "wallet.conversion.request": "طلب تحويل النقاط",
  "wallet.conversion.post": "ترحيل النقاط إلى الحساب",
  "wallet.conversion.reject": "رفض طلب تحويل النقاط",
  "wallet.conversion.cancel": "إلغاء طلب تحويل النقاط",
  "attendance.schedule": "إعداد دوام الموظف",
  "attendance.checkIn": "تسجيل الحضور",
  "attendance.checkOut": "تسجيل الانصراف",
  "attendance.settings": "إعداد نقاط وساعات الدوام",
  "attendance.autoCheckOut": "انصراف آلي يحتاج مراجعة",
  "attendance.adjustment": "تعويض أو خصم نقاط الدوام",
  "stock.transfer": "ترحيل مناقلة مخزون",
  "stock.adjustment": "ترحيل تسوية جرد",
  "page.settings": "تعديل إعدادات صفحة",
  "configuration.options.seed": "إنشاء تعريفات الخيارات الأساسية تلقائيًا",
  "configuration.roles.seed": "إنشاء أدوار الشركة الأساسية تلقائيًا",
  "configuration.options.create": "إضافة خيار جديد",
  "configuration.options.update": "تعديل تعريف خيار",
  "configuration.options.value": "حفظ قيمة خيار لسجل",
  "configuration.roles.create": "إضافة دور شركة",
  "configuration.roles.update": "تعديل دور شركة",
  "configuration.permissions.role": "تعديل صلاحية دور",
  "configuration.permissions.assignment": "إسناد دور إلى موظف",
  "configuration.permissions.employee": "استثناء صلاحية موظف",
  "control.value": "تعديل قيمة خيار الكنترول",
  "control.policy": "تعديل مفوضي خيار الكنترول",
  "centralAccess.update": "تحديد صفات الاطلاع والتعديل للعنصر",
  "centralAccess.reset": "إعادة صلاحية العنصر إلى الافتراضي",
} as const;
export type AuditAction = keyof typeof auditActionLabels;
export const publicAuditActions: AuditAction[] = [
  "question.create",
  "question.update",
  "question.answer",
  "chat.image.settings",
  "chat.group.create", "chat.group.update", "chat.group.leave", "chat.group.send", "chat.group.receipt",
  "chat.send",
  "chat.receipt",
  "notification.create",
  "notification.follow",
  "notification.assign",
  "notification.remind",
  "notification.settings",
  "owner.create",
  "user.register",
  "auth.login",
  "auth.logout",
  "auth.password",
  "user.profile",
  "media.upload",
  "user.update",
  "appearance.update",
  "users.view",
  "audit.view",
  "company.lastFallback",
  "archive.create",
  "archive.update",
  "archive.category",
  "legal.create",
  "legal.update",
  "legal.link",
  "legal.access",
  "legal.task.comment",
  "generalTable.create",
  "generalTable.duplicate",
  "generalTable.update",
  "page.settings",
];
export const companyAuditActions: AuditAction[] = [
  "question.create",
  "question.update",
  "question.answer",
  "archive.create",
  "archive.update",
  "archive.category",
  "chat.group.create", "chat.group.update", "chat.group.leave", "chat.group.send", "chat.group.receipt",
  "chat.send",
  "chat.receipt",
  "company.transactions.reset",
  "company.transactions.import",
  "company.transactions.bulk-start",
  "company.transactions.bulk-action",
  "company.transactions.bulk-complete",
  "company.transactions.sourceDates",
  "wallet.award",
  "wallet.deduct",
  "wallet.auto-award",
  "wallet.reverse",
  "wallet.task",
  "automaticTask.settings",
  "wallet.policy",
  "wallet.account",
  "wallet.conversion.request",
  "wallet.conversion.post",
  "wallet.conversion.reject",
  "wallet.conversion.cancel",
  "notification.create",
  "notification.follow",
  "notification.assign",
  "notification.remind",
  "notification.settings",
  "attendance.schedule",
  "attendance.checkIn",
  "attendance.checkOut",
  "attendance.settings",
  "attendance.autoCheckOut",
  "attendance.adjustment",
  "configuration.options.seed",
  "configuration.roles.seed",
  "configuration.options.create",
  "configuration.options.update",
  "configuration.options.value",
  "configuration.roles.create",
  "configuration.roles.update",
  "configuration.permissions.role",
  "configuration.permissions.assignment",
  "configuration.permissions.employee",
  "control.value",
  "control.policy",
  "centralAccess.update",
  "centralAccess.reset",
  "page.settings",
  "invoice.post",
  "inventory.settings",
  "stock.transfer",
  "stock.adjustment",
  "doctor.create",
  "doctor.update",
  "itemAgent.create",
  "itemAgent.update",
  "itemComposition.create",
  "itemComposition.update",
  "itemShelf.update",
  "item.create",
  "item.update",
  "media.upload",
  "financialDocument.create",
  "financialDocument.update",
  "financialDocument.post",
  "cashbox.quick-post",
  "pouch.received",
  "electronic.received",
  "financialDocument.reverse",
  "account.create",
  "account.update",
  "accountBalance.followup",
  "accountBalance.approve",
  "accounts.initialize",
  "accountLink.update",
  "currency.create",
  "currency.update",
  "currencies.initialize",
  "financeSettings.update",
  "exchangeRate.create",
  "exchangeRate.update",
  "branch.create",
  "branch.update",
  "location.create",
  "location.update",
  "company.create",
  "company.update",
  "company.letterhead.update",
  "company.view",
  "company.activate",
  "employee.create",
  "employee.update",
  "manager.appoint",
  "manager.remove",
  "manager.userArchived",
  "appearance.update",
  "audit.view",
];
export const auditTargetLabels: Record<string, string> = {
  memo: "مذكرة",
  user: "مستخدم",
  company: "شركة",
  employee: "موظف",
  appearance: "مظهر",
  audit: "سجل التدقيق",
  account: "حساب",
  accountLink: "ربط حساب نظامي",
  currency: "عملة",
  financeSettings: "إعدادات المالية",
  exchangeRate: "سعر صرف",
  branch: "فرع",
  location: "موقع",
  generalTable: "الجدول العام",
  financialDocument: "مستند مالي",
  item: "صنف",
  itemAgent: "وكيل صنف",
  itemShelf: "رف صنف",
  invoice: "فاتورة",
  inventorySettings: "إعدادات المخزون",
  stockOperation: "عملية مخزون",
  page: "صفحة",
};
export const catalog = {
  ...masterCatalog,
  ...financeCatalog,
  ...itemCatalog,
  ...commerceCatalog,
  ...inventoryCatalog,
  userKinds,
  employeeRoles,
  permissionKeys,
  userKindLabels,
  employeeRoleLabels,
  permissionLabels,
  rolePermissionTemplates,
  auditActionLabels,
  publicAuditActions,
  companyAuditActions,
  auditTargetLabels,
};

export interface User {
  id: number;
  name: string;
  displayName: string;
  email: string;
  phone: string;
  image: string;
  kind: UserKind;
  owner: boolean;
  archived: boolean;
  suspended: boolean;
  editor: boolean;
  monitor: boolean;
  createdAt: string;
}
export interface Company {
  id: number;
  name: string;
  phone: string;
  address: string;
  createdBy: number;
  createdAt: string;
}
export interface Employee {
  id: number;
  companyId: number;
  userId: number;
  name: string;
  phone: string;
  role: EmployeeRole;
  positions: EmployeePosition[];
  active: boolean;
  isGeneralManager: boolean;
  permissions: Permission[];
  displayName: string;
  email: string;
  createdBy: number;
  createdAt: string;
}
export interface AuditEvent {
  id: number;
  actorId: number | null;
  actorName: string;
  scope: "public" | "company";
  companyId: number | null;
  action: string;
  targetType: string;
  targetId: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
export interface AppearancePreference {
  mode: "light" | "dark";
  color: string;
}
export const DEFAULT_APPEARANCE: Readonly<AppearancePreference> = Object.freeze(
  {
    mode: "light",
    color: "#176b61",
  },
);
export interface SessionResponse {
  user: User | null;
  csrf: string | null;
}
export interface CompanyContext {
  company: Company;
  employee: Employee | null;
  general: boolean;
  permissions: Permission[];
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CompanyPage extends Page<Company> {
  lastCompanyId: number | null;
}
export interface ApiError {
  error: { code: string; message: string; fields?: Record<string, string[]> };
}

const text = (max: number) => z.string().trim().max(max);
const name = text(120).min(1, "الاسم مطلوب");
const phone = text(40)
  .transform((value) =>
    value
      .replace(/[\s()\-]/g, "")
      .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))),
  )
  .refine(
    (value) => value === "" || /^\+?[0-9]{3,20}$/.test(value),
    "رقم الهاتف غير صالح",
  );
const email = z.string().trim().toLowerCase().email().max(254);
const optionalEmail = z.union([z.literal(""), email]).default("");
const requiredPhone = phone.refine((value) => value !== "", "رقم الهاتف مطلوب");
const image = z.union([
  z.literal(""),
  z.string().regex(/^\/api\/media\/[a-f0-9-]{36}\/full$/),
  z
    .url()
    .refine((value) => value.startsWith("https://"), "الصورة تتطلب رابط HTTPS"),
]);
export const passwordSchema = z
  .string()
  .min(12, "كلمة المرور يجب ألا تقل عن 12 حرفًا")
  .max(128);
const profileFields = z
  .object({ name, displayName: text(120), email: optionalEmail, phone, image })
  .strict();
export const profileSchema = profileFields.transform((value) => ({
  ...value,
  displayName: value.displayName || value.name,
}));
export const registerSchema = profileFields
  .omit({ image: true })
  .extend({ image: image.optional().default(""), password: passwordSchema })
  .strict()
  .transform((value) => ({
    ...value,
    displayName: value.displayName || value.name,
  }));
export const loginSchema = z
  .object({
    email: email.optional(),
    phone: requiredPhone.optional(),
    password: z.string().min(1).max(128),
  })
  .strict()
  .refine(
    (value) => Boolean(value.email) !== Boolean(value.phone),
    "أدخل رقم الهاتف أو البريد الإلكتروني",
  );
export const ownerUserSchema = z
  .object({
    name,
    displayName: text(120).default(""),
    phone: requiredPhone,
    email: optionalEmail,
    password: passwordSchema,
  })
  .strict();
export const ownerPasswordResetSchema = z
  .object({ newPassword: passwordSchema })
  .strict();
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .strict();
export const userPatchSchema = z
  .object({
    name: name.optional(),
    displayName: text(120).optional(),
    email: optionalEmail.optional(),
    phone: phone.optional(),
    kind: z.enum(userKinds).optional(),
    archived: z.boolean().optional(),
    suspended: z.boolean().optional(),
    editor: z.boolean().optional(),
    monitor: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
export const companySchema = z
  .object({ name, phone, address: text(500) })
  .strict();
export const companyPatchSchema = companySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
const employeeFieldsSchema = z
  .object({
    userId: z.number().int().positive().max(MAX_ID).optional(),
    newUser: ownerUserSchema.optional(),
    name,
    phone,
    role: z.enum(employeeRoles),
    positions: employeePositionListSchema.optional(),
    active: z.boolean().default(true),
    createSalesCashbox: z.boolean().default(false),
    permissions: z
      .array(z.enum(permissionKeys))
      .max(permissionKeys.length)
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();
export const employeeSchema = employeeFieldsSchema.refine(
  (value) => Boolean(value.userId) !== Boolean(value.newUser),
  "اختر حسابًا موجودًا أو أنشئ مستخدمًا برقم الهاتف",
);
export const employeePatchSchema = employeeFieldsSchema
  .omit({ userId: true, newUser: true, createSalesCashbox: true })
  .extend({ active: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
export const managerSchema = z
  .object({ isGeneralManager: z.boolean() })
  .strict();
export const appearanceSchema = z
  .object({
    scope: z
      .string()
      .regex(/^(public|company:[1-9][0-9]*)$/)
      .refine(
        (value) => value === "public" || Number(value.slice(8)) <= MAX_ID,
      ),
    mode: z.enum(["light", "dark"]),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export type RegisterInput = z.input<typeof registerSchema>;
export type ProfileInput = z.input<typeof profileSchema>;
export type CompanyInput = z.input<typeof companySchema>;
export type EmployeeInput = z.input<typeof employeeSchema>;
export * from "./masters.ts";
export * from "./general-table.ts";
export * from "./finance.ts";
export * from "./account-statistics.ts";
export * from "./account-statistics-report.ts";
export * from "./items.ts";
export * from "./commerce.ts";
export * from "./doctors.ts";
export * from "./item-activity-report.ts";
export * from "./inventory.ts";

export * from "./pages.ts";
export * from "./configuration.ts";
export * from "./attendance.ts";
export * from "./notifications.ts";
export * from "./memos.ts";

export * from "./wallet.ts";
export * from "./chat.ts";
export * from "./chat-groups.ts";

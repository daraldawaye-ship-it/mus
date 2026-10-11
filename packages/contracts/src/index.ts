import { z } from "zod";
import { masterCatalog } from "./masters.ts";
import { financeCatalog } from "./finance.ts";
import { itemCatalog } from "./items.ts";
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
  "company.edit",
  "employees.view",
  "audit.view",
  "accounts.view",
  "accounts.manage",
  "currencies.view",
  "currencies.manage",
  "locations.view",
  "locations.manage",
  "finance.view",
  "finance.manage",
  "finance.post",
  "items.view",
  "items.manage",
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
  "company.edit": "تعديل بيانات الشركة",
  "employees.view": "عرض الموظفين",
  "audit.view": "عرض سجل الشركة",
  "accounts.view": "عرض دليل الحسابات",
  "accounts.manage": "إدارة دليل الحسابات",
  "currencies.view": "عرض العملات وأسعار الصرف",
  "currencies.manage": "إدارة العملات وأسعار الصرف",
  "locations.view": "عرض الفروع والمواقع",
  "locations.manage": "إدارة الفروع والمواقع",
  "finance.view": "عرض القيود والسندات والأرصدة",
  "finance.manage": "إنشاء وتعديل المسودات المالية",
  "finance.post": "ترحيل وعكس القيود والسندات",
  "items.view": "عرض الأصناف ووكلائها",
  "items.manage": "إدارة الأصناف ووكلائها",
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
  "owner.create": "إنشاء مالك المنصة",
  "user.register": "إنشاء حساب عام",
  "auth.login": "تسجيل الدخول",
  "auth.logout": "تسجيل الخروج",
  "auth.password": "تغيير كلمة المرور",
  "user.profile": "تعديل الملف الشخصي",
  "user.update": "تعديل صلاحيات الحساب",
  "appearance.update": "حفظ المظهر",
  "users.view": "عرض المستخدمين",
  "audit.view": "عرض سجل التدقيق",
  "company.create": "إنشاء شركة",
  "company.update": "تعديل بيانات الشركة",
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
  "generalTable.create": "إضافة سجل عام",
  "generalTable.update": "تعديل سجل عام",
  "financialDocument.create": "إنشاء مسودة مالية",
  "financialDocument.update": "تعديل مسودة مالية",
  "financialDocument.post": "ترحيل مستند مالي",
  "financialDocument.reverse": "عكس مستند مالي",
  "itemAgent.create": "إضافة وكيل صنف",
  "itemAgent.update": "تعديل وكيل صنف",
  "item.create": "إضافة صنف",
  "item.update": "تعديل صنف",
} as const;
export type AuditAction = keyof typeof auditActionLabels;
export const publicAuditActions: AuditAction[] = [
  "owner.create",
  "user.register",
  "auth.login",
  "auth.logout",
  "auth.password",
  "user.profile",
  "user.update",
  "appearance.update",
  "users.view",
  "audit.view",
  "company.lastFallback",
  "generalTable.create",
  "generalTable.update",
];
export const companyAuditActions: AuditAction[] = [
  "itemAgent.create",
  "itemAgent.update",
  "item.create",
  "item.update",
  "financialDocument.create",
  "financialDocument.update",
  "financialDocument.post",
  "financialDocument.reverse",
  "account.create",
  "account.update",
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
};
export const catalog = {
  ...masterCatalog,
  ...financeCatalog,
  ...itemCatalog,
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
const image = z.union([
  z.literal(""),
  z
    .url()
    .refine(
      (value) => new URL(value).protocol === "https:",
      "الصورة تتطلب رابط HTTPS",
    ),
]);
export const passwordSchema = z
  .string()
  .min(12, "كلمة المرور يجب ألا تقل عن 12 حرفًا")
  .max(128);
const profileFields = z
  .object({ name, displayName: text(120), email, phone, image })
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
  .object({ email, password: z.string().min(1).max(128) })
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
    email: email.optional(),
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
export const employeeSchema = z
  .object({
    userId: z.number().int().positive().max(MAX_ID),
    name,
    phone,
    role: z.enum(employeeRoles),
    active: z.boolean().default(true),
    permissions: z
      .array(z.enum(permissionKeys))
      .max(permissionKeys.length)
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();
export const employeePatchSchema = employeeSchema
  .omit({ userId: true })
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
export * from "./items.ts";

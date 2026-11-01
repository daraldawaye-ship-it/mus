import { z } from "zod";
import type { CompanyContext, Permission, User, Page } from "./index.ts";

export const pageActions = [
  "view",
  "create",
  "edit",
  "print",
  "post",
  "reverse",
] as const;
export type PageAction = (typeof pageActions)[number];
export const pageActionLabels: Record<PageAction, string> = {
  view: "عرض",
  create: "إضافة",
  edit: "تعديل",
  print: "طباعة",
  post: "ترحيل",
  reverse: "عكس",
};
export type PageRule = {
  role:
    | "public"
    | "guest"
    | "signed-in"
    | "owner"
    | "public-admin"
    | "public-audit"
    | "company-member"
    | "company-general"
    | "permissions";
  permissions: Permission[];
  label: string;
};
export interface PageDefinition {
  key: string;
  name: string;
  section: string;
  scope: "public" | "company";
  type: "page" | "report" | "form";
  route: string;
  description: string;
  keywords: string[];
  order: number;
  navigation: boolean;
  visible: boolean;
  critical: boolean;
  actions: Partial<Record<PageAction, PageRule>>;
  parentKey?: string;
  record?: "item" | "invoice" | "financial-document" | "memo";
}
const rule = (role: PageRule["role"], label: string): PageRule => ({
  role,
  label,
  permissions: [],
});
const permission = (...permissions: Permission[]): PageRule => ({
  role: "permissions",
  permissions,
  label: "جميع الصلاحيات المحددة",
});
const signed = rule("signed-in", "حساب مسجل فعال"),
  member = rule("company-member", "عضوية فعالة في الشركة"),
  owner = rule("owner", "مالك المنصة"),
  general = rule("company-general", "المالك أو المدير العام"),
  admin = rule("public-admin", "المالك أو الإدارة العامة"),
  auditor = rule("public-audit", "المالك أو الإدارة العامة أو مراقب عام");
const manage = (module: "accounts" | "currencies" | "locations" | "items") => ({
  view: permission(`${module}.view`),
  create: permission(`${module}.manage`),
  edit: permission(`${module}.manage`),
});
const financial = {
  view: permission("finance.view"),
  create: permission("finance.manage"),
  edit: permission("finance.manage"),
  post: permission("finance.post"),
  reverse: permission("finance.post"),
};
const invoices = {
  view: permission("commerce.view"),
  create: permission("commerce.manage", "finance.post"),
};
const entries: PageDefinition[] = [];
function page(
  key: string,
  name: string,
  section: string,
  route: string,
  actions: PageDefinition["actions"],
  description: string,
  options: Partial<PageDefinition> = {},
) {
  entries.push({
    key,
    name,
    section,
    route,
    actions,
    description,
    scope: key.startsWith("company.") ? "company" : "public",
    type: "page",
    keywords: [],
    order: entries.length * 10,
    navigation: true,
    visible: true,
    critical: false,
    ...options,
  });
}
page(
  "public.home",
  "الرئيسية",
  "الموقع العام",
  "/",
  { view: rule("public", "متاح للجميع") },
  "مدخل الموقع العام ومساحة العمل.",
  { critical: true },
);
page(
  "public.pages",
  "قائمة الصفحات",
  "الموقع العام",
  "/pages",
  { view: signed, edit: owner },
  "دليل صفحات الموقع ووظائفه وصلاحياته ومراجع الربط الثابتة.",
  { critical: true, keywords: ["دليل", "تنقل", "صلاحيات", "مذكرات", "تقارير"] },
);
page(
  "public.profile",
  "حسابي",
  "الحساب والهوية",
  "/profile",
  { view: signed, edit: signed },
  "الملف الشخصي وكلمة المرور للحساب الحالي.",
  { critical: true },
);
page(
  "public.companies",
  "الشركات",
  "الموقع العام",
  "/companies",
  { view: signed, create: owner },
  "الشركات التي يملك الحساب وصولًا إليها؛ إنشاء الشركات للمالك.",
  { critical: true },
);
page(
  "public.tasks",
  "المهام الآلية",
  "الموقع العام",
  "/tasks",
  { view: signed },
  "مهام المستخدم المولدة آليًا من الشركات التي لديه صلاحية الوصول إليها.",
);
page(
  "public.users",
  "المستخدمون",
  "إدارة المنصة",
  "/users",
  { view: admin, edit: admin },
  "إدارة الحسابات العامة؛ لا تمنح عضوية في شركة.",
);
page(
  "public.last-present",
  "آخر المتواجدين",
  "إدارة المنصة",
  "/users/last-present",
  { view: admin },
  "آخر نشاط للمستخدمين في الموقع العام بالدقائق والساعات والأيام، مع التاريخ الفعلي.",
  { parentKey: "public.users", type: "report", keywords: ["نشاط المستخدمين", "آخر تواجد", "المتواجدون", "آخر دخول"] },
);
page(
  "public.archive",
  "أرشيف المستندات والمرفقات",
  "الأرشيف",
  "/archive",
  {view:owner,create:owner,edit:owner},
  "أرشيف عام مستقل؛ رفع صور وملفات وتعديل المحتوى ووجه الاستدلال لكل ملف مع إمكانية إظهار فئات للقضايا.",
  { keywords: ["مرفقات","مستندات","أرشيف","صور","GIF","PDF"] },
);
page(
  "public.legal-cases",
  "إدارة قضايا مصطفى",
  "إدارة القضايا",
  "/legal-cases",
  {view:signed,create:owner,edit:owner},
  "القضايا والمستندات والمهام والتقارير؛ المالك له صلاحيات كاملة ويمكنه تفويض مستخدمين محددين على مستوى كل قضية؛ لا وصول افتراضي لغير المالك.",
  {keywords:["القضايا","مصطفى","ناتكو","محامي","يمن","مستندات","تسلسل زمني"]},
);
page(
  "public.explanations-reader",
  "قراءة الشروح",
  "الشروح المنظمة",
  "/explanations/topics",
  { view: signed, print: signed },
  "اختر موضوعًا رئيسيًا واحدًا، واعرض جميع فصوله متصلة مع تحميل تدريجي وطباعة الموضوع المختار كاملًا؛ دليلَا المستخدم والمطور متاحان للقراءة دون منح إضافي.",
  { keywords: ["شروح", "قراءة", "طباعة", "شرح قضايا مصطفى"] },
);
page(
  "public.explanations-editor",
  "إضافة وتعديل الشروح",
  "الشروح المنظمة",
  "/explanations?group=mustafa-cases",
  { view: signed, create: signed, edit: signed },
  "إضافة وترتيب وتعديل سجلات الشروح ومرفقاتها وفق التفويض؛ المالك فقط افتراضيًا.",
  { keywords: ["إدارة الشروح", "السجلات", "تحرير", "مرفقات"] },
);
page(
  "public.explanations-access",
  "منح صلاحيات صفحات الشروح",
  "الإدارة والصلاحيات",
  "/explanations/access",
  { view: owner, edit: owner },
  "المالك يمنح أو يلغي صلاحية قراءة الشروح أو إضافتها وتعديلها للمستخدمين، مستقلة عن صلاحيات الشركات.",
  { keywords: ["منح", "الصلاحيات", "الشروح", "القراءة", "التعديل"] },
);
page(
  "public.general-table",
  "الجدول العام",
  "إدارة المنصة",
  "/general-table",
  { view: signed, create: signed, edit: signed },
  "سجلات مرجعية عامة خاصة بإدارة المنصة.",
);
page(
  "public.audit",
  "السجل العام",
  "التدقيق",
  "/audit",
  { view: auditor },
  "سجل أحداث المنصة العام بصلاحية مستقلة عن سجل الشركة.",
);
page(
  "public.login",
  "تسجيل الدخول",
  "الحساب والهوية",
  "/login",
  { view: rule("guest", "حساب غير مسجل الدخول") },
  "تسجيل الدخول إلى الحساب العام.",
  { visible: false, navigation: false, critical: true },
);
page(
  "public.register",
  "إنشاء حساب",
  "الحساب والهوية",
  "/register",
  { view: rule("guest", "حساب غير مسجل الدخول") },
  "تسجيل حساب عام مستقل دون منح عضوية في شركة.",
  { visible: false, navigation: false, critical: true },
);
page(
  "company.overview",
  "نظرة عامة",
  "الشركة",
  "/companies/:companyId",
  { view: member },
  "ملخص الشركة ومساحة العمل.",
  { critical: true },
);
page(
  "company.pages",
  "قائمة الصفحات",
  "الشركة",
  "/companies/:companyId/pages",
  { view: member, edit: permission("pages.manage") },
  "دليل الصفحات في الشركة مع إتاحتها وصلاحيات حسابك.",
  { critical: true },
);
page(
  "company.archive",
  "أرشيف مستندات الشركة",
  "الشركة",
  "/companies/:companyId/archive",
  {view:general,create:general,edit:general},
  "ملفات الشركة الخاصة؛ رفع متعدد ومراجعة المحتوى والاستدلال مع صلاحيات صفحة مستقلة.",
  { keywords: ["مرفقات","مستندات","صور","GIF","PDF"] },
);
page(
  "company.control",
  "الكنترول",
  "الشركة",
  "/companies/:companyId/control",
  { view: member },
  "خيارات الشركة والموظف وتفويض تعديل كل خيار.",
  { critical: true },
);
page(
  "company.configuration",
  "الخيارات والصلاحيات",
  "الشركة",
  "/companies/:companyId/configuration",
  { view: permission("pages.manage"), edit: permission("pages.manage") },
  "إدارة تعريفات الخيارات والأدوار وصلاحيات موظفي الشركة.",
  { critical: true },
);
page(
  "company.central-access",
  "مركز الصلاحيات وخيارات النظام",
  "الإدارة والصلاحيات",
  "/companies/:companyId/central-access",
  { view: general,edit: general },
  "دليل برمجي لجميع الصفحات والحقول والأزرار مع تحديد صفات الاطلاع والتعديل.",
  { keywords:["موظفين","صفات","صلاحيات","حقول","أزرار","صلاحيات الاطلاع","التعديل"] },
);
page(
  "company.employees",
  "الموظفون",
  "الشركة",
  "/companies/:companyId/employees",
  { view: permission("employees.view"), create: general, edit: general },
  "الموظفون والعضويات والصلاحيات؛ تعيين المدير العام للمالك.",
);
page(
  "company.settings",
  "بيانات الشركة",
  "الشركة",
  "/companies/:companyId/settings",
  { view: permission("company.edit"), edit: permission("company.edit") },
  "اسم الشركة وبيانات الاتصال والعنوان.",
);
page(
  "company.letterhead",
  "ترويسة الشركة",
  "الشركة",
  "/companies/:companyId/letterhead",
  { view: member },
  "ترويسة الطباعة الخاصة بهذه الشركة للفواتير والسندات والتقارير. تعديل الصورة لمالك الشركة فقط.",
  { keywords: ["ترويسة", "طباعة", "شعار", "فواتير", "سندات", "مطبوعات"] },
);
page(
  "public.notifications",
  "تنبيهاتك العامة",
  "الموقع العام",
  "/notifications",
  { view: signed, edit: signed },
  "التنبيهات الآلية العامة الموجهة إليك ومتابعتها.",
);
page(
  "public.notification-templates",
  "أنواع التنبيهات العامة",
  "الموقع العام",
  "/notification-templates",
  { view: owner, edit: owner },
  "كروت أنواع التنبيهات العامة وإعداد أهميتها ومتابعتها.",
);
page(
  "company.notifications",
  "التنبيهات",
  "الشركة",
  "/companies/:companyId/notifications",
  { view: member, edit: member },
  "تنبيهاتك العامة وتنبيهات هذه الشركة فقط، مع القراءة والإنجاز والتأجيل.",
);
page(
  "company.notification-templates",
  "أنواع التنبيهات",
  "الشركة",
  "/companies/:companyId/notification-templates",
  { view: general, edit: general },
  "إعداد أنواع التنبيهات الآلية والأهمية والأدوار والمتابعين والتكرار.",
);
page(
  "public.questions",
  "الأسئلة",
  "الموقع العام",
  "/questions",
  { view: signed, create: owner, edit: owner },
  "أسئلة الموقع العامة مع اختيار عدد الأجوبة ونقاط السؤال.",
);
page("public.medicine-market", "سوق الأدوية", "سوق الأدوية", "/medicine-market",
  { view: rule("public", "متاح للجميع"), create: signed, edit: signed },
  "دليل عام تشاركي للأصناف والتركيبات والجهات؛ مساهمات يدوية على مستوى الحقل.",
  { keywords: ["دواء", "صيدلية", "وكيل", "تركيب", "سعر", "أدوية"] });
page("public.medicine-market-review", "مصادقة السوق", "سوق الأدوية", "/medicine-market/review",
  { view: admin, edit: admin }, "مراجعة مساهمات الحقول والتعليقات قبل اعتمادها.",
  { parentKey: "public.medicine-market" });
page("public.medicine-market-contributions", "مساهماتي في السوق", "سوق الأدوية", "/medicine-market/contributions",
  { view: signed, create: signed }, "متابعة المساهمات ونقاطها المعتمدة.",
  { parentKey: "public.medicine-market" });
page("public.medicine-market-points", "نقاط حقول السوق", "سوق الأدوية", "/medicine-market/points",
  { view: admin, edit: admin }, "تحديد نقاط الإضافة والتعديل لكل حقل ونوع كرت.",
  { parentKey: "public.medicine-market" });
page(
  "public.answers",
  "الإجابات",
  "الموقع العام",
  "/answers",
  { view: signed, create: signed },
  "إجاباتك وتعليقاتك؛ المالك يستطيع متابعة إجابات المستخدمين.",
);
page(
  "company.questions",
  "الأسئلة",
  "الشركة",
  "/companies/:companyId/questions",
  { view: member, create: general, edit: general },
  "أسئلة الشركة وخياراتها ونقاطها، مع عزل بيانات كل شركة.",
);
page(
  "company.answers",
  "الإجابات",
  "الشركة",
  "/companies/:companyId/answers",
  { view: member, create: member },
  "الإجابات والتعليقات؛ المدير العام يطلع على إجابات جميع مستخدمي الشركة.",
);
page(
  "company.memos",
  "المذكرات",
  "الشركة",
  "/companies/:companyId/memos",
  { view: member, create: member, edit: member, post: member },
  "التكليفات والمراسلات وطلبات اعتماد الإنجاز؛ تعرض الإدارة جميع مذكرات الشركة، ويعتمد الإنجاز مرسل المذكرة.",
  { keywords: ["مذكرة", "مهمة", "استفسار", "مراجعة", "اعتماد"] },
);
page(
  "company.memo-report",
  "تقرير المذكرات",
  "الشركة",
  "/companies/:companyId/memo-report",
  {view:member},
  "تقارير التكليفات وحركة مسؤوليتها ومدد التنفيذ وانتظار الاعتماد.",
  {parentKey:"company.memos",type:"report",keywords:["مذكرات","تقارير","تأجيل","مدة","مهام"]},
);
page(
  "company.memo-feature-rules",
  "قواعد ميزات المذكرات",
  "الشركة",
  "/companies/:companyId/memo-feature-rules",
  {view:general,edit:general},
  "قواعد مراقبة التكليفات المعلقة وتنبيه الموظفين حسب العدد والمدة والأدوار.",
  {parentKey:"company.memos",keywords:["قواعد","تكليفات","مراقبة","تنبيه"]},
);
page(
  "company.memo-detail",
  "عرض المذكرة",
  "الشركة",
  "/companies/:companyId/memos/:recordId",
  { view: member },
  "عرض المذكرة وردودها والمسؤول الحالي وسجل انتقالها وطلب الإنجاز واعتماده؛ فتح المذكرة لا ينجزها.",
  { parentKey: "company.memos", record: "memo", navigation: false },
);
page(
  "company.tasks",
  "المهام الآلية",
  "الشركة",
  "/companies/:companyId/tasks",
  { view: member, edit: general },
  "قائمة المهام الآلية، وكنترول التفعيل والعدد وصلاحيات التكليف والمتابعة لكل مهمة.",
);
page(
  "company.wallet",
  "النقاط والمحفظة",
  "الموظفون",
  "/companies/:companyId/wallet",
  { view: member, create: general, reverse: general },
  "محفظة الموظف وسجل نقاطه، مع إضافات إدارية موثقة وتصحيح بحركات عكسية.",
);
page(
  "company.reward-tasks",
  "مهام المكافآت",
  "الموظفون",
  "/companies/:companyId/reward-tasks",
  { view: general, edit: general },
  "إعداد نقاط مهام المكافآت الآلية وشروط تكرارها وأدوارها وتفعيلها.",
);
page(
  "company.wallet-settings",
  "إعدادات المحفظة",
  "الموظفون",
  "/companies/:companyId/wallet-settings",
  { view: general, edit: general },
  "إعداد قيمة النقطة وعملة التحويل وحساب المصروف وربط الموظفين بحساباتهم.",
);
page(
  "company.wallet-conversions",
  "تحويلات النقاط",
  "الموظفون",
  "/companies/:companyId/wallet-conversions",
  { view: member, create: member, edit: member, post: general },
  "تحويل نقاطك إلى حسابك، ومتابعة الطلبات واعتمادها أو رفضها من الإدارة.",
);
page(
  "company.attendance",
  "الحضور والانصراف",
  "الموظفون",
  "/companies/:companyId/attendance",
  { view: member, create: member, edit: general },
  "تسجيل الحضور والانصراف وإعداد دوام الموظفين والسجل اليومي.",
);
page(
  "company.attendance-current",
  "المحضرون حاليًا",
  "الموظفون",
  "/companies/:companyId/attendance-current",
  { view: member },
  "جميع موظفي الشركة الفعالين مع آخر حضور وانصراف؛ المحضرون أولًا بحسب أحدث حضور.",
  { parentKey: "company.attendance", type: "report", keywords: ["حاضر", "انصراف", "محضر", "دوام", "آخر حضور"] },
);
page(
  "company.accounts",
  "دليل الحسابات",
  "المحاسبة",
  "/companies/:companyId/accounts",
  manage("accounts"),
  "شجرة الحسابات والحسابات المرحلة والروابط النظامية.",
  { keywords: ["الحسابات", "محاسبة"] },
);
page(
  "company.currencies",
  "العملات",
  "المحاسبة",
  "/companies/:companyId/currencies",
  manage("currencies"),
  "العملات ودقتها والعملة الأساسية للشركة.",
);
page(
  "company.exchange-rates",
  "أسعار الصرف",
  "المحاسبة",
  "/companies/:companyId/exchange-rates",
  manage("currencies"),
  "أسعار صرف فعلية مؤرخة؛ لا تُختلق أسعار مفقودة.",
);
page(
  "company.branches",
  "الفروع",
  "الشركة",
  "/companies/:companyId/branches",
  manage("locations"),
  "الفروع ومعرض الفرع الرئيسي.",
);
page(
  "company.locations",
  "المعارض والمخازن",
  "الشركة",
  "/companies/:companyId/locations",
  manage("locations"),
  "مواقع المخزون وإتاحتها داخل الفروع.",
);
page(
  "company.sale-customers",
  "العملاء",
  "المبيعات",
  "/companies/:companyId/sale-customers",
  { view: permission("commerce.view"), create: permission("commerce.manage"), edit: permission("commerce.manage") },
  "كروت عملاء المبيعات بأرقامهم وأسمائهم، مستقلة عن الحسابات المالية.",
  { keywords: ["عميل","زبون","رقم العميل","اسم العميل"] },
);
page(
  "company.doctors",
  "الأطباء والجهات",
  "المبيعات",
  "/companies/:companyId/doctors",
  { view: permission("commerce.view"), create: permission("commerce.manage"), edit: permission("commerce.manage") },
  "كروت الأطباء والممرضين والجهات، لربط الطبيب بفواتير المبيعات.",
  { keywords: ["طبيب", "ممرض", "مستشفى", "قسم", "جهات"] },
);
page(
  "company.items",
  "الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/items",
  manage("items"),
  "كروت الأصناف والوحدات الثلاث والأسعار والعملات.",
  { keywords: ["منتج", "صنف", "باركود"] },
);
page(
  "company.item-statistics-report",
  "تقرير إحصائيات الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/item-statistics-report",
  { view: permission("items.view","commerce.view") },
  "الكميات المباعة والمشتراة والمرتجعات لآخر شهر وأربعة أشهر واثني عشر شهرًا ومنذ البداية.",
  { type: "report", keywords: ["إحصائيات", "كميات", "مبيعات", "مشتريات", "أصناف", "تقارير"] },
);
page(
  "company.item-options-list",
  "قائمة الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/item-options-list",
  { view: permission("items.view", "commerce.view"),
    edit: permission("items.manage") },
  "قائمة أصناف قابلة للتصفية حسب الكمية المتوفرة دون المرتجعات، ومرات البيع والكفاية مع الاحتياطي أو بدونه.",
  { type: "report", keywords: ["قائمة", "الأصناف", "المتوفر", "المبيعات", "المرات", "الكفاية", "الاحتياطي"] },
);
page(
  "company.item-card",
  "كرت الصنف",
  "الأصناف والمخزون",
  "/companies/:companyId/items/:recordId",
  { view: permission("items.view"), edit: permission("items.manage") },
  "عرض صنف محدد وتعديل كرته بحسب الصلاحية.",
  { parentKey: "company.items", record: "item", navigation: false },
);
page(
  "company.item-new",
  "إضافة صنف",
  "الأصناف والمخزون",
  "/companies/:companyId/items/new",
  { view: permission("items.manage"), create: permission("items.manage") },
  "إنشاء كرت صنف جديد بمعرف ورمز ثابتين.",
  { parentKey: "company.items", navigation: false, type: "form" },
);
page(
  "company.item-compositions",
  "تراكيب الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/item-compositions",
  manage("items"),
  "كروت التركيب ومحددات البديل المطابق أو عدم قابلية التبديل.",
  { keywords: ["تركيب", "تركيبة", "composition", "بدائل"] },
);
page(
  "company.item-form-differences",
  "متابعة اختلاف شكل الصنف والتركيب",
  "الأصناف والمخزون",
  "/companies/:companyId/item-form-differences",
  { view: permission("items.view") },
  "مقارنة شكل الصنف مع الشكل المحدد في كرت التركيب، ومراجعة غير المصنف (عام).",
  { type:"report", keywords:["شكل الصنف","شكل التركيب","مطابقة","اختلاف","تصنيف","عام"] },
);
page(
  "company.item-shelves",
  "كرت الرفوف",
  "الأصناف والمخزون",
  "/companies/:companyId/item-shelves",
  manage("items"),
  "إدارة ٣٣٦ رفًا ضمن ٢٨ مجموعة من الحروف العربية، مع خيارات الأرشفة والبترينة.",
  { keywords: ["رف", "رفوف", "مجموعة", "بترينة", "vitrine", "shelf"] },
);
page(
  "company.item-agents",
  "وكلاء الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/item-agents",
  manage("items"),
  "وكلاء الأصناف وربطهم بكروت الشركة.",
);
page(
  "company.settlement-follow-up",
  "متابعة التسويات للأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/settlement-follow-up",
  { view: permission("items.view", "commerce.view", "inventory.view") },
  "متابعة مرات المبيعات خلال آخر شهر وسعر الشراء وأقرب انتهاء وآخر تسوية من إحصائيات الصنف.",
  { type: "report", keywords: ["تسوية", "متابعة التسويات", "مبيعات", "مرات", "انتهاء", "جرد"] },
);
page(
  "company.stock-balances",
  "أرصدة المخزون",
  "التقارير",
  "/companies/:companyId/stock-balances",
  { view: permission("inventory.view") },
  "الرصيد حسب الصنف والموقع والدفعة والتكلفة.",
  { type: "report", keywords: ["تقارير", "رصيد", "مخزون"] },
);
page(
  "company.stock-movements",
  "حركات المخزون",
  "التقارير",
  "/companies/:companyId/stock-movements",
  { view: permission("inventory.view") },
  "حركة الأصناف ومصادرها وكمياتها وتكلفتها.",
  { type: "report", keywords: ["حركة الأصناف", "حركات", "تقارير"] },
);
page(
  "company.stock-operations",
  "المناقلات",
  "الأصناف والمخزون",
  "/companies/:companyId/stock-operations",
  {
    view: permission("inventory.view", "inventory.post"),
    create: permission("inventory.post", "finance.post"),
  },
  "مناقلات المخزون بين المواقع داخل الشركة.",
);
page(
  "company.stock-adjustments",
  "تسوية الأصناف",
  "الأصناف والمخزون",
  "/companies/:companyId/stock-adjustments",
  {
    view: permission("inventory.view", "inventory.post"),
    create: permission("inventory.post", "finance.post"),
  },
  "الجرد الفعلي بكميات كل وحدة وتحديث أقرب انتهاء الصنف.",
  { keywords: ["تسوية", "جرد", "مخزون", "انتهاء"] },
);
page(
  "company.inventory-settings",
  "إعداد المخزون",
  "الأصناف والمخزون",
  "/companies/:companyId/inventory-settings",
  {
    view: permission("inventory.manage"),
    edit: permission("inventory.manage"),
  },
  "حسابات المخزون والتكلفة وسياسة الجرد.",
);
page(
  "company.sales",
  "فواتير المبيعات",
  "الفواتير",
  "/companies/:companyId/sales",
  invoices,
  "المبيعات ومردوداتها؛ السعر من كرت الصنف والترحيل ذري.",
  { keywords: ["بيع", "مردود", "فاتورة"] },
);
page(
  "company.pouch-receipts",
  "استلام الترحيلات",
  "الفواتير",
  "/companies/:companyId/pouch-receipts",
  {view:permission("finance.view"),post:permission("finance.post")},
  "حركات الحوافظ: استلام مطابق أو غير مطابق إلى صندوق المستلم وترحيل الفرق تلقائيًا.",
  {parentKey:"company.sales",keywords:["الحوافظ","استلام","ترحيل","صندوق","عجز","زيادة"]},
);
page(
  "company.electronic-receipts",
  "استلام المحفظة الإلكترونية",
  "الفواتير",
  "/companies/:companyId/electronic-receipts",
  {view:permission("finance.view"),post:permission("finance.post")},
  "استلام الترحيلات إلى محفظة الشركة الإلكترونية مطابقة أو غير مطابقة إلى صندوق الموظف المستلم، مع تسجيل العجز والزيادة.",
  {parentKey:"company.sales",keywords:["المحفظة الإلكترونية","استلام","تحويل","الهاتف","صندوق","عجز","زيادة"]},
);
page(
  "company.purchases",
  "فواتير المشتريات",
  "الفواتير",
  "/companies/:companyId/purchases",
  invoices,
  "المشتريات ومردوداتها وتواريخ انتهاء الأصناف عند الحاجة.",
  { keywords: ["شراء", "مردود", "فاتورة"] },
);
page(
  "company.sale-new",
  "إضافة فاتورة مبيعات",
  "الفواتير",
  "/companies/:companyId/invoices/new?kind=sale",
  {
    view: permission("commerce.manage", "finance.post"),
    create: permission("commerce.manage", "finance.post"),
  },
  "إدخال سطور البيع والمردودات وحفظها وترحيلها.",
  { parentKey: "company.sales", navigation: false, type: "form" },
);
page(
  "company.purchase-new",
  "إضافة فاتورة مشتريات",
  "الفواتير",
  "/companies/:companyId/invoices/new?kind=purchase",
  {
    view: permission("commerce.manage", "finance.post"),
    create: permission("commerce.manage", "finance.post"),
  },
  "إدخال سطور الشراء والمردودات وحفظها وترحيلها.",
  { parentKey: "company.purchases", navigation: false, type: "form" },
);
page(
  "company.invoice",
  "عرض الفاتورة",
  "الفواتير",
  "/companies/:companyId/invoices/:recordId",
  { view: permission("commerce.view"), print: permission("commerce.view") },
  "الفاتورة المرحلة وطباعة أصلها وروابط القيود والحركات؛ لا تعديل مباشر بعد الترحيل.",
  { record: "invoice", navigation: false },
);
page(
  "company.financial-documents",
  "العمليات المالية",
  "المحاسبة",
  "/companies/:companyId/financial-documents",
  financial,
  "كل القيود والسندات ومسوداتها وحالتها.",
);
page(
  "company.journals",
  "قيود اليومية",
  "المحاسبة",
  "/companies/:companyId/journals",
  financial,
  "القيود اليدوية ومسوداتها وترحيلها وعكسها الموثق.",
  { parentKey: "company.financial-documents" },
);
page(
  "company.receipts",
  "سندات القبض",
  "المحاسبة",
  "/companies/:companyId/receipts",
  financial,
  "سندات القبض وحسابات النقد والبنك.",
  { parentKey: "company.financial-documents" },
);
page(
  "company.payments",
  "سندات الصرف",
  "المحاسبة",
  "/companies/:companyId/payments",
  financial,
  "سندات الصرف وحسابات النقد والبنك.",
  { parentKey: "company.financial-documents" },
);
page(
  "company.financial-new",
  "إضافة مستند مالي",
  "المحاسبة",
  "/companies/:companyId/financial-documents/new",
  { view: permission("finance.manage"), create: permission("finance.manage") },
  "إنشاء مسودة قيد أو سند؛ الترحيل يحتاج صلاحية مستقلة.",
  { parentKey: "company.financial-documents", navigation: false, type: "form" },
);
page(
  "company.financial-document",
  "عرض المستند المالي",
  "المحاسبة",
  "/companies/:companyId/financial-documents/:recordId",
  { ...financial, print: permission("finance.view") },
  "عرض أو تعديل المسودة؛ المستند المرحل ثابت ولا يطبع قبل الترحيل.",
  {
    parentKey: "company.financial-documents",
    record: "financial-document",
    navigation: false,
  },
);
page(
  "company.account-balances",
  "أرصدة الحسابات",
  "التقارير",
  "/companies/:companyId/account-balances",
  { view: permission("finance.view") },
  "الأرصدة المحاسبية المشتقة من القيود المرحلة.",
  { type: "report", keywords: ["تقارير", "رصيد"] },
);
page(
  "company.account-ledger",
  "كشف حساب",
  "التقارير",
  "/companies/:companyId/account-ledger",
  { view: permission("finance.view") },
  "افتتاحي الفترة وحركة الحساب ورصيده الختامي.",
  { type: "report", keywords: ["تقارير", "حركة الحساب"] },
);
page(
  "company.my-cashbox-ledger",
  "كشف حساب صندوقي",
  "التقارير",
  "/companies/:companyId/my-cashbox-ledger",
  { view: permission("finance.own-cashbox.view") },
  "حركة صندوق المبيعات الخاص بالموظف فقط، بصلاحية مستقلة حتى لو كان لديه صندوق.",
  { type: "report", keywords: ["صندوقي", "صندوق المبيعات", "حركة الصندوق", "رصيد الصندوق"] },
);
page(
  "company.account-statistics",
  "إحصاءات الحسابات",
  "التقارير",
  "/companies/:companyId/account-statistics",
  {
    view: permission("accounts.view", "finance.view"),
    create: permission("accounts.balance-followup"),
    post: permission("accounts.balance-approve"),
  },
  "الأرصدة التاريخية ومتابعة الحساب واعتماد الرصيد.",
  {
    type: "report",
    parentKey: "company.accounts",
    navigation: true,
    visible: true,
  },
);
page(
  "company.audit",
  "سجل الشركة",
  "التدقيق",
  "/companies/:companyId/audit",
  { view: permission("audit.view") },
  "تدقيق العمليات داخل الشركة والفاعل والوقت والقيم قبل وبعد.",
);
page(
  "public.chat",
  "دردشة الرئيسي",
  "الموقع العام",
  "/chat",
  { view: signed, create: signed },
  "محادثات خاصة بين مستخدمي الرئيسي مع تأكيد الاستلام والعرض.",
  { order: 45, keywords: ["دردشة", "محادثات", "رسائل", "استلام", "عرض"] },
);
page(
  "company.chat",
  "دردشة الشركة",
  "التواصل",
  "/companies/:companyId/chat",
  { view: member, create: member },
  "محادثات خاصة بين الأعضاء الفعالين في الشركة؛ مستقلة عن دردشة الموقع العام.",
  { order: 275, keywords: ["دردشة", "محادثات", "رسائل", "موظفين"] },
);
export const pageDefinitions: readonly PageDefinition[] = entries;
export const pageByKey = (key: string) =>
  pageDefinitions.find((entry) => entry.key === key);
export function pageRuleAllows(
  rule: PageRule | undefined,
  user: User | null,
  context?: CompanyContext | null,
): boolean {
  if (!rule) return false;
  switch (rule.role) {
    case "public":
      return true;
    case "guest":
      return !user;
    case "signed-in":
      return !!user;
    case "owner":
      return !!user?.owner;
    case "public-admin":
      return !!user && (user.owner || user.kind === "admin");
    case "public-audit":
      return !!user && (user.owner || user.kind === "admin" || user.monitor);
    case "company-member":
      return !!context;
    case "company-general":
      return !!context?.general;
    case "permissions":
      return (
        !!context &&
        (context.general ||
          rule.permissions.every((permission) =>
            context.permissions.includes(permission),
          ))
      );
  }
}
export interface PageEntry extends PageDefinition {
  id: string;
  href: string | null;
  enabled: boolean;
  configuredVisible: boolean;
  configuredEnabled: boolean;
  globalVisible: boolean;
  globalEnabled: boolean;
  revision: number | null;
  canConfigure: boolean;
  actionAccess: Record<PageAction, boolean>;
}
export interface PageDirectory extends Page<PageEntry> {
  sections: string[];
  summary: {
    total: number;
    available: number;
    hidden: number;
    disabled: number;
    reports: number;
  };
}
export const pageSettingSchema = z
  .object({
    companyId: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .nullable()
      .default(null),
    visible: z.boolean(),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(100000),
    revision: z.number().int().positive().nullable(),
  })
  .strict();
export const pageReferenceSchema = z
  .object({
    pageKey: z
      .string()
      .regex(/^(public|company)\.[a-z-]+$/)
      .max(100),
    companyId: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .nullable()
      .default(null),
    recordId: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .nullable()
      .default(null),
  })
  .strict();
export type PageReference = z.infer<typeof pageReferenceSchema>;
export interface ResolvedPage {
  reference: PageReference;
  href: string;
  title: string;
}
export function pageHref(
  definition: PageDefinition,
  companyId?: number | null,
  recordId?: number | null,
): string | null {
  if (definition.scope === "company" && !companyId) return null;
  if (definition.record && !recordId) return null;
  return definition.route
    .replace(":companyId", String(companyId))
    .replace(":recordId", String(recordId));
}
export function pageReferenceHref(reference: PageReference): string {
  const query = new URLSearchParams();
  if (reference.companyId) query.set("companyId", String(reference.companyId));
  if (reference.recordId) query.set("recordId", String(reference.recordId));
  return `/go/${reference.pageKey}${query.size ? `?${query}` : ""}`;
}

export function pageKeyForLocation(
  pathname: string,
  search: string,
): string | undefined {
  const params = new URLSearchParams(search);
  return pageDefinitions.find((entry) => {
    const [path, query] = entry.route.split("?");
    const pattern = path!
      .split("/")
      .map((part) => (part.startsWith(":") ? "[1-9]\\d*" : part))
      .join("/");
    if (!new RegExp(`^${pattern}/?$`).test(pathname)) return false;
    if (query)
      return [...new URLSearchParams(query)].every(
        ([key, value]) =>
          (params.get(key) ?? (key === "kind" ? "sale" : "")) === value,
      );
    return true;
  })?.key;
}

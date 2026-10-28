export const marketKinds = [
  "medicine",
  "composition",
  "scientific-name",
  "dosage-form",
  "pharmacy",
  "wholesaler",
  "agent",
  "manufacturer",
  "doctor",
  "hospital",
  "clinic",
  "college",
] as const;
export type MarketKind = (typeof marketKinds)[number];
export type MarketVisibility = "public" | "ministry" | "accounting";
export type MarketFieldType =
  | "text"
  | "textarea"
  | "boolean"
  | "decimal"
  | "percent"
  | "date"
  | "url"
  | "relation"
  | "contacts"
  | "ingredients"
  | "accounting";
export interface MarketField {
  key: string;
  label: string;
  type: MarketFieldType;
  relationKind?: MarketKind;
  options?: string[];
  visibility: MarketVisibility;
  price?: boolean;
}
export interface MarketType {
  key: MarketKind;
  label: string;
  fields: MarketField[];
}
const f = (
  key: string,
  label: string,
  type: MarketFieldType = "text",
  extra: Partial<MarketField> = {},
): MarketField => ({ key, label, type, visibility: "public", ...extra });
const name = f("name", "الاسم");
const image = f("image", "الصورة", "url");
const address = f("address", "العنوان", "textarea");
const phone = f("phone", "رقم التواصل");
const contacts = f("contacts", "أرقام المسؤولين", "contacts");
const keywords = f("keywords", "مفاتيح البحث");
const directory = [name, phone, address, contacts, keywords];
export const marketTypes: MarketType[] = [
  {
    key: "medicine",
    label: "الأصناف",
    fields: [
      f("name", "اسم الصنف بالعربي"),
      f("englishName", "اسم الصنف بالإنجليزي"),
      f("dosageFormId", "الشكل الصيدلاني", "relation", {
        relationKind: "dosage-form",
      }),
      f("compositionId", "التركيب", "relation", {
        relationKind: "composition",
      }),
      f("purchasePrice", "سعر الشراء من الوكيل", "decimal", { price: true }),
      f("currency", "العملة", "text", { price: true }),
      f("agentBonus", "بونص الوكيل %", "percent", { price: true }),
      image,
      f("description", "وصف العبوة", "textarea"),
      f("hasExpiry", "له تاريخ انتهاء", "boolean"),
      f("agentId", "الوكيل", "relation", { relationKind: "agent" }),
      f("manufacturerId", "الشركة المصنّعة", "relation", {
        relationKind: "manufacturer",
      }),
      f("barcode", "الباركود"),
      keywords,
      f("ministryPrice", "سعر البيع من وزارة الصحة", "decimal", {
        visibility: "ministry",
        price: true,
      }),
      f("ministryNotes", "ملاحظات وزارة الصحة", "textarea", {
        visibility: "ministry",
      }),
      f("ministryNoticeUntil", "تاريخ توقف ملاحظة الوزارة", "date", {
        visibility: "ministry",
      }),
      f(
        "accountingMappings",
        "معرفات الأنظمة المحاسبية — حتى 8",
        "accounting",
        { visibility: "accounting" },
      ),
    ],
  },
  {
    key: "composition",
    label: "التركيبات",
    fields: [
      f("name", "اسم التركيب"),
      f("dosageFormId", "الشكل الصيدلاني", "relation", {
        relationKind: "dosage-form",
      }),
      f("ingredients", "الأسماء العلمية والقوة", "ingredients"),
      keywords,
    ],
  },
  {
    key: "scientific-name",
    label: "الأسماء العلمية",
    fields: [
      f("name", "الاسم العلمي"),
      image,
      f("details", "التفاصيل", "textarea"),
      f("wikipediaEn", "ويكيبيديا الإنجليزية", "url"),
      f("wikipediaAr", "ويكيبيديا العربية", "url"),
      keywords,
    ],
  },
  {
    key: "dosage-form",
    label: "الأشكال الصيدلانية",
    fields: [name, f("englishName", "الاسم الإنجليزي"), keywords],
  },
  { key: "pharmacy", label: "الصيدليات", fields: directory },
  { key: "wholesaler", label: "محلات الجملة", fields: directory },
  { key: "agent", label: "الوكلاء", fields: directory },
  {
    key: "manufacturer",
    label: "الشركات المصنّعة",
    fields: [
      name,
      f("country", "البلد"),
      f("agentId", "الوكيل", "relation", { relationKind: "agent" }),
      image,
      keywords,
    ],
  },
  {
    key: "doctor",
    label: "الأطباء",
    fields: [...directory, f("specialty", "التخصص")],
  },
  { key: "hospital", label: "المستشفيات والمراكز", fields: directory },
  { key: "clinic", label: "العيادات", fields: directory },
  { key: "college", label: "الكليات", fields: directory },
];
export interface MarketPermissions {
  canContribute: boolean;
  canModerate: boolean;
  canConfigure: boolean;
  canSeeMinistry: boolean;
  canSeeAccounting: boolean;
  canArchive: boolean;
}
export interface MarketFieldMeta extends MarketField {
  points: { add: number; edit: number };
  policyRevision: number;
}
export interface MarketMeta {
  types: (Omit<MarketType, "fields"> & { fields: MarketFieldMeta[] })[];
  permissions: MarketPermissions;
  userPoints: string;
}
export interface MarketCard {
  id: number;
  kind: MarketKind;
  name: string;
  data: Record<string, unknown>;
  status: "pending" | "published" | "rejected";
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  likes: number;
  ratingAverage: number | null;
  ratingCount: number;
  myLiked: boolean;
  myRating: number | null;
  createdBy: number;
}
export interface MarketContribution {
  id: number;
  cardId: number;
  cardName: string;
  kind: MarketKind;
  fieldKey: string;
  fieldLabel: string;
  previousValue: unknown;
  value: unknown;
  source: string;
  authorId: number;
  authorName: string;
  status: "pending" | "approved" | "rejected" | "conflict";
  published: boolean;
  awardedPoints: number;
  reviewerId: number | null;
  reason: string;
  createdAt: string;
  reviewedAt: string | null;
}
export interface MarketComment {
  id: number;
  cardId: number;
  cardName: string;
  authorId: number;
  authorName: string;
  text: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}
export interface MarketDetail {
  card: MarketCard;
  comments: MarketComment[];
  contributions: MarketContribution[];
}

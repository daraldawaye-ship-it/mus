/** Company-scoped option definitions and permission administration. */
export const optionValueTypes = [
  "boolean",
  "text",
  "integer",
  "decimal",
  "date",
  "list",
] as const;
export type OptionValueType = (typeof optionValueTypes)[number];
export type OptionScalar = boolean | string | null;
export type OptionRecordKind =
  "item" | "account" | "employee" | "invoice" | "financial-document";
export type PermissionEffect = "allow" | "deny";

export interface OptionDefinition {
  id: number;
  key: string;
  pageKey: string;
  recordKind: OptionRecordKind;
  name: string;
  description: string;
  valueType: OptionValueType;
  defaultValue: OptionScalar;
  choices: { key: string; label: string }[];
  required: boolean;
  searchable: boolean;
  showOnCard: boolean;
  showInList: boolean;
  sortOrder: number;
  active: boolean;
  system: boolean;
  nativeBinding: string | null;
  revision: number;
}

/** Metadata and exact option scalars returned with supported record lists. */
export type OptionListRecord<T> = T & {
  optionValues: Record<string, OptionScalar>;
};
export interface OptionListMetadata {
  optionDefinitions: OptionDefinition[];
}

/** Validate exact scalar strings without converting large numbers to floats. */
export function optionValueError(
  definition: Pick<OptionDefinition, "valueType" | "choices" | "required">,
  value: OptionScalar,
): string | null {
  if (value === null || (value === "" && definition.valueType === "text")) {
    return definition.required ? "أدخل قيمة لهذا الخيار الإلزامي." : null;
  }
  if (definition.valueType === "boolean")
    return typeof value === "boolean" ? null : "اختر نعم أو لا.";
  if (typeof value !== "string") return "القيمة لا تطابق نوع الخيار.";
  if (definition.valueType === "integer")
    return /^-?(0|[1-9][0-9]{0,27})$/.test(value)
      ? null
      : "أدخل عددًا صحيحًا دون فواصل أو أصفار زائدة.";
  if (definition.valueType === "decimal")
    return /^-?(0|[1-9][0-9]{0,21})(\.[0-9]{1,6})?$/.test(value)
      ? null
      : "أدخل عددًا عشريًا بالنقطة وبحد أقصى 6 منازل عشرية.";
  if (definition.valueType === "date") {
    const date = new Date(value + "T00:00:00Z");
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) &&
      value >= "0001-01-01" &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
      ? null
      : "أدخل تاريخًا صحيحًا.";
  }
  if (definition.valueType === "list")
    return definition.choices.some((choice) => choice.key === value)
      ? null
      : "اختر قيمة من القائمة.";
  return value.length <= 2000 ? null : "الحد الأقصى للنص 2000 حرف.";
}

export interface ConfigurationFoundation {
  companyId: number;
  stage: "management";
  authorizationMode: "employee-permissions-and-page-rules";
  administrationAvailable: true;
  valueTypes: readonly OptionValueType[];
  summary: {
    options: number;
    storedValues: number;
    permissionDefinitions: number;
    roles: number;
    roleAssignments: number;
    roleRules: number;
    employeeRules: number;
  };
  /** Preview is bounded; directory search/pagination belongs to the next stage. */
  options: OptionDefinition[];
  roles: { id: number; key: string; name: string; active: boolean }[];
}

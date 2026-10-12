/** Storage foundation. Editing and new role-based enforcement arrive in a later stage. */
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

export interface ConfigurationFoundation {
  companyId: number;
  stage: "foundation";
  authorizationMode: "existing-employee-permissions";
  administrationAvailable: false;
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

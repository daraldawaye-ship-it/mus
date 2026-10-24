import { HttpError } from "./errors.ts";

// Case files copied into the dedicated owner-only case workspace remain
// confidential in their original general-table tables as well.
export const PRIVATE_LEGAL_TABLES = [
  "قضايا مصطفى",
  "قصايا مصطفى",
  "معطيات في قضية مصطفى",
  "مستندات قضايا مصطفى",
  "مهام في قضايا مصطفى",
] as const;

export function requireLegalLegacyOwner(isOwner: boolean, tableName: string): void {
  if (!isOwner && (PRIVATE_LEGAL_TABLES as readonly string[]).includes(tableName))
    throw new HttpError(403, "legal_owner_only", "ملفات قضايا مصطفى متاحة لمالك المنصة فقط");
}

import type { Database } from "../db.ts";
import type {
  User,
  AuditAction,
} from "../../../../packages/contracts/src/index.ts";
/** Snapshots of card updates already exist. Expose the committed field-level
 * differences separately, without logging credentials, metadata noise, or
 * duplicating item.field.update (which is already implemented by item routes).
 */
const cardTargets = new Set([
  "account", "doctor", "saleCustomer", "employee", "user",
  "itemComposition", "itemAgent", "itemShelf", "branch", "location",
  "currency", "exchangeRate", "company", "company_device", "accountLink",
  "generalTable", "archive",
]);
const ignoredAuditFields = /(?:password|token|secret|credential|csrf|hash|session|api[_-]?key|private[_-]?key|otp|\bpin\b|refresh[_-]?key)/i;
const auditMetadataFields = new Set([
  "revision", "createdAt", "updatedAt", "createdBy", "updatedBy",
  "created_at", "updated_at", "lastModified", "lastSeenAt",
]);
function safeFieldValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return null;
  if (typeof value === "string")
    return value.length > 1000 ? value.slice(0, 1000) + "… [مختصر]" : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (depth >= 2) return "[بيانات مركبة مختصرة]";
  if (Array.isArray(value))
    return value.slice(0, 20).map(item => safeFieldValue(item, depth + 1));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !ignoredAuditFields.test(key))
        .slice(0, 20).map(([key, item]) => [key, safeFieldValue(item, depth + 1)]),
    );
  return String(value);
}
async function auditCardFieldChanges(
  db: Database,
  actor: User,
  action: AuditAction,
  targetType: string,
  targetId: number | null,
  before: object,
  after: object,
  companyId: number | null,
) {
  if (!cardTargets.has(targetType) || !action.endsWith(".update") || targetId === null)
    return;
  const oldValues = before as Record<string, unknown>;
  const newValues = after as Record<string, unknown>;
  const changed = Object.keys(newValues).filter(field =>
    !auditMetadataFields.has(field) &&
    !ignoredAuditFields.test(field) &&
    Object.prototype.hasOwnProperty.call(oldValues, field) &&
    JSON.stringify(oldValues[field] ?? null) !== JSON.stringify(newValues[field] ?? null));
  if (!changed.length) return;
  // The original full audit entry remains intact. One compact batch insert
  // captures each changed field; no extra query is run for unrelated actions.
  const args: unknown[] = [];
  const rows = changed.map(field => {
    const start = args.length;
    args.push(actor.id, actor.displayName, companyId === null ? "public" : "company",
      companyId, "card.field.update", targetType, targetId,
      JSON.stringify({ field, value: safeFieldValue(oldValues[field]) }),
      JSON.stringify({ field, value: safeFieldValue(newValues[field]) }));
    return "(" + Array.from({ length: 9 }, (_, i) => "$" + (start + i + 1)).join(",") + ")";
  });
  await db.query(
    "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES " + rows.join(","),
    args,
  );
}
export async function audit(
  db: Database,
  actor: User | null,
  action: AuditAction,
  targetType: string,
  targetId: number | null,
  before: object | null,
  after: object | null,
  companyId: number | null = null,
): Promise<void> {
  await db.query(
    "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      actor?.id ?? null,
      actor?.displayName ?? "النظام",
      companyId === null ? "public" : "company",
      companyId,
      action,
      targetType,
      targetId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
    ],
  );
  if (actor && before !== null && after !== null)
    await auditCardFieldChanges(db, actor, action, targetType, targetId, before, after, companyId);
}

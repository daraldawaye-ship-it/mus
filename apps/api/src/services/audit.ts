import type { Database } from "../db.ts";
import type {
  User,
  AuditAction,
} from "../../../../packages/contracts/src/index.ts";
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
}

import type { QueryResultRow } from "pg";
import type {
  User,
  Company,
  Employee,
  AuditEvent,
} from "../../../../packages/contracts/src/index.ts";
type Row = QueryResultRow;
const iso = (value: Date | string): string => new Date(value).toISOString();
export function userDTO(row: Row): User {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    image: row.image,
    kind: row.kind,
    owner: row.owner,
    archived: row.archived,
    suspended: row.suspended,
    editor: row.editor,
    monitor: row.monitor,
    createdAt: iso(row.created_at),
  };
}
export function companyDTO(row: Row): Company {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}
export function employeeDTO(row: Row): Employee {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    positions: row.position_keys ?? [],
    active: row.active,
    isGeneralManager: row.is_general_manager,
    permissions: row.permissions,
    displayName: row.display_name,
    email: row.email,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}
export function auditDTO(row: Row): AuditEvent {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    scope: row.scope,
    companyId: row.company_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before_value,
    after: row.after_value,
    createdAt: iso(row.created_at),
  };
}
export const employeeSelect =
  "SELECT e.*,u.display_name,u.email FROM employees e JOIN users u ON u.id=e.user_id";

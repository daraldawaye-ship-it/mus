import type { Database } from "../db.ts";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { defaultUserCategory } from "../../../../packages/contracts/src/user-category.ts";

type DockUserCard = Pick<User,
  "id" | "displayName" | "kind" | "archived" | "suspended" | "createdAt"
> & { category: NonNullable<User["category"]> };

export async function readDockUserCard(db: Database, userId: number): Promise<DockUserCard | null> {
  const result = await db.query<{
    id: number;
    display_name: string;
    kind: User["kind"];
    category: User["category"] | null;
    archived: boolean;
    suspended: boolean;
    created_at: Date | string;
  }>(
    "SELECT id, display_name, kind, category, archived, suspended, created_at FROM users WHERE id=$1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    category: row.category ?? defaultUserCategory,
    archived: row.archived,
    suspended: row.suspended,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

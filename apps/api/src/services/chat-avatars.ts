import type { Database } from "../db.ts";

/** Only the current, owned, uploaded profile thumbnail is shared in chat. */
export async function chatAvatarUrls(
  db: Database, companyId: number | null, userIds: number[],
): Promise<Map<number, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = (await db.query(
    `SELECT u.id,asset.id AS asset_id FROM users u JOIN media_assets asset
       ON asset.uploaded_by=u.id AND asset.purpose='avatar' AND asset.company_id IS NULL
       AND u.image='/api/media/'||asset.id::text||'/full'
     WHERE u.id=ANY($1::integer[]) AND NOT u.archived AND NOT u.suspended
       AND ($2::integer IS NULL OR u.owner OR EXISTS(SELECT 1 FROM employees membership
         WHERE membership.company_id=$2 AND membership.user_id=u.id AND membership.active))`,
    [ids, companyId],
  )).rows;
  return new Map(rows.map(row => {
    const query = new URLSearchParams({ scope: companyId === null ? "global" : "company", v: row.asset_id });
    if (companyId !== null) query.set("companyId", String(companyId));
    return [row.id, `/api/chat/avatars/${row.id}?${query.toString()}`];
  }));
}

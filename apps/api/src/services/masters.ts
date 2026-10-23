import type { Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  Permission,
  User,
} from "../../../../packages/contracts/src/index.ts";
import type { Database } from "../db.ts";
import { transaction } from "../db.ts";
import { assertRequestPagesEnabled } from "./pages.ts";
import { actor, id } from "../http.ts";
import { companyAccess, currentActor } from "../policies/access.ts";
import { HttpError, missing } from "../errors.ts";
import { listQuery, searchPattern } from "./lists.ts";
import { optionListPlan } from "./option-lists.ts";

export function conflict(message: string): never {
  throw new HttpError(409, "conflict", message);
}
export async function readMaster(
  pool: Pool,
  req: Request,
  permission: Permission,
): Promise<number> {
  const companyId = id(req.params.companyId);
  const user = await currentActor(pool, actor(req), false);
  await companyAccess(pool, user, companyId, permission);
  return companyId;
}
export async function mutateMaster<T>(
  pool: Pool,
  req: Request,
  permission: Permission,
  action: (client: PoolClient, user: User, companyId: number) => Promise<T>,
): Promise<T> {
  const companyId = id(req.params.companyId);
  return transaction(pool, async (client) => {
    const user = await currentActor(client, actor(req));
    await companyAccess(client, user, companyId, permission, true);
    await assertRequestPagesEnabled(client, req, true);
    return action(client, user, companyId);
  });
}
export async function masterRow(
  db: Database,
  select: string,
  alias: string,
  companyId: number,
  rowId: number,
): Promise<QueryResultRow> {
  const result = await db.query(
    `${select} WHERE ${alias}.company_id=$1 AND ${alias}.id=$2`,
    [companyId, rowId],
  );
  if (!result.rows[0]) missing();
  return result.rows[0];
}
export async function masterPage<T>(
  pool: Database,
  req: Request,
  companyId: number,
  select: string,
  from: string,
  alias: string,
  columns: Record<string, string>,
  searchColumns: string[],
  dto: (row: QueryResultRow) => T,
  filters: Record<string, "boolean" | "id" | readonly string[]>,
  fallback = "id:asc",
  optionKind?: "item" | "account",
  exactMatchColumns: string[] = [],
  searchPlan?: { withSql: string; predicate: string },
) {
  const options = optionKind
    ? await optionListPlan(pool, req, companyId, optionKind, alias)
    : null;
  const query = listQuery(
    req.query,
    { ...columns, ...options?.sortColumns },
    fallback,
  );
  const parameters: unknown[] = [companyId, searchPattern(query.q)];
  const prefix = query.q && searchPlan ? `${searchPlan.withSql} ` : "";
  const search = searchPlan
    ? (query.q ? searchPlan.predicate : "$2::text IS NOT NULL")
    : searchColumns.map((column) => `${column} ILIKE $2`).join(" OR ");
  let filter = `${alias}.company_id=$1 AND (${search}${query.q && options?.search ? ` OR ${options.search}` : ""})`;
  for (const [field, allowed] of Object.entries(filters)) {
    const value = req.query[field];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new HttpError(400, "invalid_query", "الفلتر غير صالح");
    let normalized: string | boolean | number;
    if (allowed === "boolean") {
      if (!["true", "false"].includes(value))
        throw new HttpError(400, "invalid_query", "الحالة غير صالحة");
      normalized = value === "true";
    } else if (allowed === "id") normalized = id(value);
    else {
      if (!allowed.includes(value))
        throw new HttpError(400, "invalid_query", "الفلتر غير صالح");
      normalized = value;
    }
    const column = columns[field];
    if (!column) throw new Error("Missing filter column");
    parameters.push(normalized);
    filter += ` AND ${column}=$${parameters.length}`;
  }
  const optionFilter = options?.filter(parameters);
  if (optionFilter) filter += ` AND ${optionFilter}`;
  const count = await pool.query(
    `${prefix}SELECT count(*)::integer AS total ${from} WHERE ${filter}`,
    parameters,
  );
  // Exact code/barcode matches take precedence over popularity. Bind the raw
  // search value separately so it can never become part of SQL syntax.
  const rowParameters: unknown[] = [...parameters];
  let order = query.order;
  if (query.q && exactMatchColumns.length) {
    rowParameters.push(query.q);
    const exactParameter = `$${rowParameters.length}::text`;
    order = `CASE WHEN (${exactMatchColumns.map(
      (column) => `lower(${column})=lower(${exactParameter})`,
    ).join(" OR ")}) THEN 0 ELSE 1 END ASC, ${order}`;
  }
  const rows = await pool.query(
    `${prefix}${select} WHERE ${filter} ORDER BY ${order} LIMIT $${rowParameters.length + 1} OFFSET $${rowParameters.length + 2}`,
    [...rowParameters, query.pageSize, query.offset],
  );
  return {
    items: options ? await options.rows(rows.rows, dto) : rows.rows.map(dto),
    total: count.rows[0].total as number,
    page: query.page,
    pageSize: query.pageSize,
    ...(options ? { optionDefinitions: options.definitions } : {}),
  };
}

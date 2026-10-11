import { HttpError } from "../errors.ts";
export interface ListQuery {
  page: number;
  pageSize: number;
  offset: number;
  q: string;
  order: string;
}
export function listQuery(
  query: Record<string, unknown>,
  columns: Record<string, string>,
  fallback = "id:asc",
): ListQuery {
  const integer = (
    value: unknown,
    defaultValue: number,
    max: number,
  ): number => {
    if (value === undefined) return defaultValue;
    if (typeof value !== "string" || !/^\d+$/.test(value))
      throw new HttpError(400, "invalid_query", "طلب تصفح غير صالح");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
      throw new HttpError(400, "invalid_query", "طلب تصفح غير صالح");
    return parsed;
  };
  const page = integer(query.page, 1, 1000000),
    pageSize = integer(query.pageSize, 25, 100);
  const q = query.q === undefined ? "" : query.q;
  if (typeof q !== "string" || q.length > 200)
    throw new HttpError(400, "invalid_query", "نص البحث غير صالح");
  const sort = query.sort === undefined ? fallback : query.sort;
  if (typeof sort !== "string" || sort.length > 250)
    throw new HttpError(400, "invalid_sort", "الترتيب غير صالح");
  const seen = new Set<string>(),
    orders: string[] = [];
  for (const item of sort.split(",")) {
    const [field, direction, ...extra] = item.split(":");
    if (
      extra.length ||
      !field ||
      !Object.hasOwn(columns, field) ||
      !["asc", "desc"].includes(direction) ||
      seen.has(field)
    )
      throw new HttpError(400, "invalid_sort", "الترتيب غير صالح");
    seen.add(field);
    orders.push(`${columns[field]} ${direction.toUpperCase()}`);
  }
  if (!seen.has("id")) orders.push(`${columns.id} ASC`);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    q: q.trim(),
    order: orders.join(", "),
  };
}
export const searchPattern = (q: string): string =>
  `%${q.replace(/[\\%_]/g, "\\$&")}%`;

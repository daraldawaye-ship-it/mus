// The items directory starts with active items. Keep "all" as an explicit
// option so removing the filter is intentional and survives refresh/links.
export type ItemActiveFilter = "true" | "false" | "all";
export function itemActiveFilter(raw: string | null): ItemActiveFilter {
  if (raw === "all" || raw === "false") return raw;
  return "true";
}
export function itemActiveQueryValue(filter: ItemActiveFilter): string | null {
  return filter === "all" ? null : filter;
}

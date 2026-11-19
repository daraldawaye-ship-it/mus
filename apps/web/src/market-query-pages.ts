import type { InfiniteData } from "@tanstack/react-query";
import { normalizeMarketPath } from "./market-offline";

export function marketPageBoundary(value: unknown) {
  const page = value as { nextCursor?: unknown; items?: { id?: unknown }[] } | null;
  return JSON.stringify([page?.nextCursor, page?.items?.map(item => item.id)]);
}

/** Apply newer responses in cursor order. A changed boundary invalidates its tail. */
export function mergeMarketPageUpdates<T, P>(
  current: InfiniteData<T, P> | undefined,
  updates: ReadonlyMap<string, T>,
  path: (page: P) => string,
): InfiniteData<T, P> | undefined {
  if (!current || updates.size === 0) return current;
  const pages = [...current.pages];
  const pageParams = [...current.pageParams];
  let changed = false;
  for (let index = 0; index < pageParams.length; index++) {
    const updated = updates.get(normalizeMarketPath(path(pageParams[index])));
    if (updated === undefined) continue;
    if (marketPageBoundary(pages[index]) !== marketPageBoundary(updated)) {
      pages.length = index + 1;
      pageParams.length = index + 1;
    }
    if (pages[index] !== updated) changed = true;
    pages[index] = updated;
  }
  return changed ? { pages, pageParams } : current;
}

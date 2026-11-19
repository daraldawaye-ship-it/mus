import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useInfiniteQuery, useQuery, useQueryClient,
  type InfiniteData, type QueryClient, type QueryKey,
} from "@tanstack/react-query";
import { api } from "./api";
import { connectionSnapshot, subscribeConnection } from "./connection-mode";
import {
  getMarketCacheScope, getMarketReadStatus, normalizeMarketPath, subscribeMarketCache,
} from "./market-offline";
import { mergeMarketPageUpdates } from "./market-query-pages";

const noScope = () => null;
const scopeSubscription = (notify: () => void) => subscribeMarketCache(event => {
  if (event.type === "scope") notify();
});

/** A visitor session and an owner session never share even an in-memory result. */
export function useMarketCacheScope() {
  return useSyncExternalStore(scopeSubscription, getMarketCacheScope, noScope);
}

export function useMarketOffline() {
  return useSyncExternalStore(subscribeConnection, connectionSnapshot, () => "online") !== "online";
}

function useMarketReconnect(client: QueryClient, queryKey: QueryKey, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { void client.invalidateQueries({ queryKey, exact: true }); };
    window.addEventListener("alraesy-network-restored", refresh);
    return () => window.removeEventListener("alraesy-network-restored", refresh);
  }, [client, queryKey, enabled]);
}

export function useMarketReadStatus(path: string) {
  const scope = useMarketCacheScope();
  const normalized = normalizeMarketPath(path);
  const subscribe = useCallback((notify: () => void) => subscribeMarketCache(event => {
    if (event.type === "scope" || event.scope === scope &&
        (!event.path || normalizeMarketPath(event.path) === normalized)) notify();
  }), [scope, normalized]);
  const snapshot = useCallback(() => getMarketReadStatus(normalized), [scope, normalized]);
  return useSyncExternalStore(subscribe, snapshot, noScope);
}

function useScopedKey(queryKey: QueryKey, scope: string | null) {
  const serialized = JSON.stringify(queryKey);
  // Keep the existing prefix so field saves can invalidate all current market reads.
  return useMemo(() => [...queryKey, "market-scope", scope] as const, [serialized, scope]);
}

function clearDisplayedQuery(client: QueryClient, queryKey: QueryKey) {
  // Removing an active cache entry alone leaves its observer showing the old data.
  // Cancel the read and explicitly clear its displayed result on an access rejection.
  void client.cancelQueries({ queryKey, exact: true }, { revert: false });
  client.getQueryCache().find({ queryKey, exact: true })?.setState({
    data: undefined,
    dataUpdatedAt: 0,
    error: new Error("لم تعد هذه النسخة المحفوظة متاحة؛ أعد الاتصال لتحميل البيانات المسموح بها."),
    errorUpdatedAt: Date.now(),
    fetchStatus: "idle",
    status: "error",
  });
}

type MarketQueryOptions = {
  queryKey: QueryKey;
  path: string;
  enabled?: boolean;
  fresh?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
};

/** API returns local data immediately; its background update replaces this result. */
export function useMarketQuery<T>({ path, queryKey: baseKey, enabled = true, fresh = false, ...options }: MarketQueryOptions) {
  const client = useQueryClient();
  const scope = useMarketCacheScope();
  const queryKey = useScopedKey(baseKey, scope);
  useMarketReconnect(client, queryKey, enabled && scope !== null);
  const normalized = normalizeMarketPath(path);
  const result = useQuery<T, Error>({
    ...options,
    queryKey,
    queryFn: ({ signal }) => api<T>(path, { signal, marketFresh: fresh }),
    enabled: enabled && scope !== null,
    networkMode: "always",
    retry: false,
  });
  useEffect(() => subscribeMarketCache(event => {
    if (event.scope !== scope || scope === null) return;
    if (event.path && normalizeMarketPath(event.path) !== normalized) return;
    if (event.type === "cleared") clearDisplayedQuery(client, queryKey);
    if (event.type === "updated" && event.data !== undefined) {
      client.setQueryData<T>(queryKey, event.data as T);
    }
  }), [client, scope, normalized, queryKey]);
  const marketStatus = useMarketReadStatus(normalized);
  return { ...result, marketPath: normalized, marketStatus };
}

type MarketInfiniteQueryOptions<T, P> = {
  queryKey: QueryKey;
  path: (page: P) => string;
  initialPageParam: P;
  getNextPageParam: (last: T) => P | null | undefined;
  enabled?: boolean;
};

/** Replace a refreshed page without joining it to a now-obsolete cursor chain. */
export function useMarketInfiniteQuery<T, P>({
  path, queryKey: baseKey, enabled = true, initialPageParam, getNextPageParam,
}: MarketInfiniteQueryOptions<T, P>) {
  const client = useQueryClient();
  const scope = useMarketCacheScope();
  const queryKey = useScopedKey(baseKey, scope);
  const duringFetch = useMemo(() => new Map<string, T>(), [queryKey]);
  useMarketReconnect(client, queryKey, enabled && scope !== null);
  const result = useInfiniteQuery<T, Error, InfiniteData<T, P>, QueryKey, P>({
    queryKey,
    queryFn: ({ pageParam, signal }) => api<T>(path(pageParam as P), { signal }),
    initialPageParam,
    getNextPageParam,
    enabled: enabled && scope !== null,
    networkMode: "always",
    retry: false,
  });
  useEffect(() => subscribeMarketCache(event => {
    if (event.scope !== scope || scope === null) return;
    const saved = client.getQueryData<InfiniteData<T, P>>(queryKey);
    if (event.type === "cleared" && (!event.path || saved?.pageParams.some(page =>
      normalizeMarketPath(path(page)) === normalizeMarketPath(event.path!)))) {
      duringFetch.clear();
      clearDisplayedQuery(client, queryKey);
      return;
    }
    if (event.type !== "updated" || event.data === undefined || !event.path || !saved) return;
    const normalized = normalizeMarketPath(event.path);
    const index = saved.pageParams.findIndex(page => normalizeMarketPath(path(page)) === normalized);
    // A newly requested page is appended by React Query when its request completes.
    if (index < 0) return;
    const fetching = client.getQueryState(queryKey);
    if (fetching?.fetchStatus === "fetching") duringFetch.set(normalized, event.data as T);
    // fetchNextPage captured its own oldPages before this background refresh.
    // Even a price-only change would otherwise be replaced by that old array
    // when the append completes. Do not cancel the initial/refetch request
    // whose successful API response may itself be publishing this update.
    if (fetching?.fetchStatus === "fetching" && fetching.fetchMeta?.fetchMore?.direction === "forward") {
      void client.cancelQueries({ queryKey, exact: true }, { revert: false });
    }
    client.setQueryData<InfiniteData<T, P>>(queryKey, current =>
      mergeMarketPageUpdates(current, new Map([[normalized, event.data as T]]), path));
  }), [client, scope, queryKey, path, duringFetch]);
  useEffect(() => {
    // A full refetch assembles its own pages array. It may have read a saved
    // first page before a background 200 arrived while loading a later page.
    // Reapply those newer responses once the assembly finishes, without
    // canceling the successful request or repeatedly invalidating queries.
    if (client.getQueryState(queryKey)?.fetchStatus === "fetching" || duringFetch.size === 0) return;
    const updates = new Map(duringFetch);
    duringFetch.clear();
    client.setQueryData<InfiniteData<T, P>>(queryKey, current =>
      mergeMarketPageUpdates(current, updates, path));
  }, [client, queryKey, path, duringFetch, result.isFetching, result.dataUpdatedAt]);
  const marketPath = normalizeMarketPath(path(result.data?.pageParams.at(-1) ?? initialPageParam));
  const marketStatus = useMarketReadStatus(marketPath);
  return { ...result, marketPath, marketStatus };
}

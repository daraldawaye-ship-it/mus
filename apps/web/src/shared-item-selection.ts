import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { errorMessage } from "./phase2";
import type { TemporaryChosenItem } from "./temporary-item-list";

type PendingChoice = { item: TemporaryChosenItem; checked: boolean };

/**
 * The selection belongs to the item ID in PostgreSQL, not to the row index
 * or the browser. Each in-flight choice overlays server polls until its write
 * and its confirmation refetch both complete, so checking another item never
 * moves or removes the first item's checkmark.
 */
export function useSharedItemSelection(
  companyId: number, userId: number | string | undefined,
) {
  const client = useQueryClient();
  const key = useMemo(() => ["item-shared-selection", companyId, userId] as const,
    [companyId, userId]);
  const [pending, setPending] = useState<Map<number, PendingChoice>>(() => new Map());
  const pendingRef = useRef<Map<number, PendingChoice>>(new Map());
  const clearingRef = useRef(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");

  const query = useQuery<{ items: TemporaryChosenItem[] }>({
    queryKey: key,
    queryFn: ({ signal }) => api<{ items: TemporaryChosenItem[] }>(
      `/companies/${companyId}/item-temporary-selection`, { signal }),
    enabled: userId !== undefined && companyId > 0,
    refetchInterval: 10000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });

  useEffect(() => {
    pendingRef.current = new Map();
    setPending(new Map());
    clearingRef.current = false;
    setClearing(false);
    setError("");
  }, [companyId, userId]);

  // The overlay is keyed by the immutable company item ID, never the list
  // position. Polls, sorting, filtering and pagination cannot displace it.
  const items = useMemo(() => {
    const byId = new Map<number, TemporaryChosenItem>(
      (query.data?.items ?? []).map(item => [item.id, item]));
    for (const [id, choice] of pending) {
      if (choice.checked) byId.set(id, choice.item);
      else byId.delete(id);
    }
    return [...byId.values()];
  }, [query.data?.items, pending]);

  const enabled = userId !== undefined && companyId > 0 && !query.isError && !clearing;
  const pendingIds = useMemo(() => new Set(pending.keys()), [pending]);
  const updating = clearing || pendingIds.size > 0;

  const toggle = useCallback(async (item: TemporaryChosenItem, checked: boolean) => {
    if (userId === undefined || companyId <= 0 || clearingRef.current
      || pendingRef.current.has(item.id)) return false;
    setError("");
    const choice: PendingChoice = { item, checked };
    pendingRef.current.set(item.id, choice);
    setPending(new Map(pendingRef.current));
    try {
      const response = await api<{ item: { id: number; checked: boolean } }>(
        `/companies/${companyId}/item-temporary-selection/${item.id}`, {
          method: "PATCH", body: { checked },
        });
      if (response.item.id !== item.id || response.item.checked !== checked)
        throw new Error("لم يؤكد الخادم حفظ اختيار الصنف المطلوب.");
      // Preserve this pending overlay while refetching. An older fetch must
      // never make another item appear checked or undo this item momentarily.
      await client.invalidateQueries({ queryKey: key, exact: true });
      return true;
    } catch (reason) {
      setError(`تعذر حفظ الاختيار للصنف «${item.name}»: ${errorMessage(reason)}`);
      return false;
    } finally {
      pendingRef.current.delete(item.id);
      setPending(new Map(pendingRef.current));
    }
  }, [companyId, userId, client, key]);

  const clear = useCallback(async () => {
    if (userId === undefined || clearingRef.current || pendingRef.current.size)
      return false;
    clearingRef.current = true;
    setClearing(true);
    setError("");
    try {
      await api(`/companies/${companyId}/item-temporary-selection`, {
        method: "DELETE", body: { confirm: true },
      });
      await client.invalidateQueries({ queryKey: key, exact: true });
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  }, [companyId, userId, client, key]);

  return {
    items, toggle, clear, enabled, updating, pendingIds,
    error: error || (query.isError ? errorMessage(query.error) : ""),
    loading: query.isPending, refresh: query.refetch,
  };
}

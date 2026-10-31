import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { errorMessage } from "./phase2";
import type { TemporaryChosenItem } from "./temporary-item-list";

/** Shared across all authorized employees and devices of the same company. */
export function useSharedItemSelection(
  companyId: number, userId: number | string | undefined,
) {
  const client = useQueryClient();
  const key = ["item-shared-selection", companyId, userId] as const;
  const [updating, setUpdating] = useState(false);
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
  const items = query.data?.items ?? [];
  const enabled = userId !== undefined && !query.isError && !updating;

  const toggle = useCallback(async (item: TemporaryChosenItem, checked: boolean) => {
    if (updating || userId === undefined) return false;
    setError("");
    setUpdating(true);
    const previous = client.getQueryData<{ items: TemporaryChosenItem[] }>(key);
    const before = previous?.items ?? [];
    client.setQueryData(key, { items: checked
      ? before.some(entry => entry.id === item.id) ? before : [...before, item]
      : before.filter(entry => entry.id !== item.id),
    });
    try {
      await api(`/companies/${companyId}/item-temporary-selection/${item.id}`, {
        method: "PATCH", body: { checked },
      });
      await client.invalidateQueries({ queryKey: key });
      return true;
    } catch (reason) {
      client.setQueryData(key, previous);
      setError(errorMessage(reason));
      return false;
    } finally {
      setUpdating(false);
    }
  }, [companyId, userId, updating, client, key[0], key[1], key[2]]);

  const clear = useCallback(async () => {
    if (updating || userId === undefined) return false;
    setError("");
    setUpdating(true);
    try {
      await api(`/companies/${companyId}/item-temporary-selection`, {
        method: "DELETE", body: { confirm: true },
      });
      await client.invalidateQueries({ queryKey: key });
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setUpdating(false);
    }
  }, [companyId, userId, updating, client, key[0], key[1], key[2]]);

  return {
    items, toggle, clear,
    enabled, updating, error: error || (query.isError ? errorMessage(query.error) : ""),
    loading: query.isPending, refresh: query.refetch,
  };
}

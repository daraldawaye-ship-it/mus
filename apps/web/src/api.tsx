import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import type {
  Page,
  SessionResponse,
  User,
} from "../../../packages/contracts/src/index";

export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
let csrf: string | null = null;
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const mutation = method !== "GET" && method !== "HEAD";
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      ...(mutation ? { "Content-Type": "application/json" } : {}),
      ...(mutation && csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  const data: unknown = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = (data as { error?: { message?: string; code?: string } })
      .error;
    throw new ApiFailure(
      error?.message ?? "تعذر إكمال الطلب",
      response.status,
      error?.code ?? "unknown",
    );
  }
  return data as T;
}
interface SessionValue {
  user: User | null;
  csrf: string | null;
  loading: boolean;
  error: string | null;
  reloadSession: () => Promise<void>;
  logout: () => Promise<void>;
  pendingLogoutRedirect: boolean;
  acknowledgeLogoutRedirect: () => void;
}
interface SessionState extends SessionResponse {
  pendingLogoutRedirect: boolean;
}
const SessionContext = createContext<SessionValue | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [session, setSession] = useState<SessionState>({
    user: null,
    csrf: null,
    pendingLogoutRedirect: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const reloadSession = async () => {
    const request = ++epoch.current;
    const result = await api<SessionResponse>("/auth/session");
    if (epoch.current !== request) return;
    csrf = result.csrf;
    setSession({ ...result, pendingLogoutRedirect: false });
    setError(null);
    setLoading(false);
  };
  useEffect(() => {
    const controller = new AbortController();
    const request = ++epoch.current;
    void api<SessionResponse>("/auth/session", { signal: controller.signal })
      .then((result) => {
        if (epoch.current === request) {
          csrf = result.csrf;
          setSession({ ...result, pendingLogoutRedirect: false });
          setLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : "تعذر الاتصال");
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, []);
  const logout = async () => {
    ++epoch.current;
    await api("/auth/logout", { method: "POST" });
    await client.cancelQueries();
    client.clear();
    ++epoch.current;
    csrf = null;
    // Auth guards must share the logout destination until the router commits it.
    setSession({ user: null, csrf: null, pendingLogoutRedirect: true });
  };
  const acknowledgeLogoutRedirect = useCallback(() => {
    setSession((current) =>
      current.pendingLogoutRedirect
        ? { ...current, pendingLogoutRedirect: false }
        : current,
    );
  }, []);
  return (
    <SessionContext.Provider
      value={{
        ...session,
        loading,
        error,
        reloadSession,
        logout,
        acknowledgeLogoutRedirect,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider missing");
  return value;
}
export function useScopeGuard(scope: string) {
  const { user } = useSession();
  const identity = `${user?.id ?? "guest"}:${scope}`;
  const current = useRef(identity);
  current.current = identity;
  const state = useMemo(
    () => ({ identity, controller: new AbortController(), active: true }),
    [identity],
  );
  useEffect(() => {
    if (state.controller.signal.aborted)
      state.controller = new AbortController();
    state.active = true;
    return () => {
      state.active = false;
      state.controller.abort();
    };
  }, [state]);
  return {
    get signal() {
      return state.controller.signal;
    },
    isCurrent: () =>
      state.active &&
      !state.controller.signal.aborted &&
      current.current === state.identity,
  };
}
export function usePagedQuery<T, Extra = Record<never, never>>(
  resource: string,
  scope: string,
  defaultSort = "id:asc",
) {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : 20;
  const sorting: SortingState = (params.get("sort") ?? defaultSort)
    .split(",")
    .filter(Boolean)
    .map((value) => {
      const [id, dir] = value.split(":");
      return { id, desc: dir === "desc" };
    });
  const write = (values: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      Object.entries(values).forEach(([key, value]) =>
        value === null ? next.delete(key) : next.set(key, value),
      );
      return next;
    });
  const sort =
    sorting
      .map((item) => `${item.id}:${item.desc ? "desc" : "asc"}`)
      .join(",") || defaultSort;
  const result = useQuery({
    queryKey: ["list", user?.id, scope, resource, query, page, pageSize, sort],
    queryFn: ({ signal }) => {
      const [pathname, search = ""] = resource.split("?");
      const fields = new URLSearchParams(search);
      fields.set("q", query);
      fields.set("page", String(page));
      fields.set("pageSize", String(pageSize));
      fields.set("sort", sort);
      return api<Page<T> & Extra>(`${pathname}?${fields}`, { signal });
    },
    enabled: !!user,
  });
  const setSorting: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    write({
      sort:
        next
          .map((item) => `${item.id}:${item.desc ? "desc" : "asc"}`)
          .join(",") || defaultSort,
      page: null,
    });
  };
  return {
    data: result.data,
    loading: result.isFetching,
    error: result.error,
    query,
    page,
    pageSize,
    sorting,
    setQuery: (value: string) => write({ q: value || null, page: null }),
    setPage: (value: number) => write({ page: String(value) }),
    setPageSize: (value: number) =>
      write({ pageSize: String(value), page: null }),
    setSorting,
    refetch: result.refetch,
  };
}

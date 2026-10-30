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
import { clearOfflineSession, readOfflineSession, rememberRead, savedRead, saveOfflineSession, setOfflineUser } from "./offline-storage";
import { clearOfflineSharedGrants, restoreOfflineSharedGrants, reuseAuthorizedRead, shareAuthorizedRead, sharedIdentity } from "./offline-shared";
import { lookupSharedItem } from "./offline-shared-items";
import { offlineUser } from "./offline-storage";
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
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      signal: options.signal,
      headers: {
        ...(mutation ? { "Content-Type": "application/json" } : {}),
        ...(mutation && csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch (error) {
    // A network failure may use a saved read, never a cached authentication
    // response or a simulated successful financial mutation.
    if (method === "GET" && !options.signal?.aborted) {
      const offline = await savedRead<T>(path).catch(() => undefined);
      if (offline !== undefined) return offline;
      const reusable = await reuseAuthorizedRead<T>(path).catch(() => undefined);
      if (reusable !== undefined) return reusable;
      const id=offlineUser();
      if (id!==null) {
        const item=await lookupSharedItem<T>(path,id).catch(()=>undefined);
        if (item!==undefined) return item;
      }
    }
    throw error;
  }
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
  if (method === "GET") {
    void rememberRead(path, data).catch(() => {});
    void shareAuthorizedRead(path, data).catch(() => {});
  }
  return data as T;
}
interface SessionValue {
  user: User | null;
  offlineMode: boolean;
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
  const [offlineMode, setOfflineMode] = useState(false);
  const epoch = useRef(0);
  // An offline restart can re-open only a previously authenticated user on
  // this device. No password or CSRF token is stored; live API permissions
  // remain authoritative for every mutation and upon reconnect.
  async function applyLiveSession(result: SessionResponse, request: number) {
    if (epoch.current !== request) return;
    csrf = result.csrf;
    if (result.user) await saveOfflineSession(result.user).catch(() => {});
    else {
      const prior=offlineUser();
      await clearOfflineSession().catch(() => {});
      if(prior!==null) await clearOfflineSharedGrants(prior).catch(()=>{});
    }
    if (epoch.current !== request) return;
    setOfflineUser(result.user?.id ?? null);
    sharedIdentity(result.user?.id ?? null);
    setSession({ ...result, pendingLogoutRedirect: false });
    setOfflineMode(false);
    setError(null);
    setLoading(false);
  }
  async function recoverOffline(error: unknown, request: number): Promise<boolean> {
    // An HTTP auth rejection is NOT an offline condition. In particular, do
    // not revive a removed/suspended user from IndexedDB after HTTP 401/403.
    if (error instanceof ApiFailure) {
      if (error.status === 401 || error.status === 403) {
        const prior=offlineUser();
        await clearOfflineSession().catch(() => {});
        if(prior!==null) await clearOfflineSharedGrants(prior).catch(()=>{});
        if (epoch.current === request) {
          csrf = null;
          setOfflineUser(null);
          sharedIdentity(null);
          setSession({ user: null, csrf: null, pendingLogoutRedirect: false });
          setOfflineMode(false);
        }
      }
      return false;
    }
    if (navigator.onLine && !(error instanceof TypeError)) return false;
    const user = await readOfflineSession().catch(() => null);
    if (!user || epoch.current !== request) return false;
    csrf = null;
    setOfflineUser(user.id);
    sharedIdentity(user.id);
    await restoreOfflineSharedGrants(user.id).catch(() => {});
    if(epoch.current!==request) return false;
    setSession({ user, csrf: null, pendingLogoutRedirect: false });
    setOfflineMode(true);
    setError(null);
    setLoading(false);
    return true;
  }
  const reloadSession = async () => {
    const request = ++epoch.current;
    try {
      const result = await api<SessionResponse>("/auth/session");
      await applyLiveSession(result, request);
    } catch (error) {
      if (!(await recoverOffline(error, request))) throw error;
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    const request = ++epoch.current;
    void api<SessionResponse>("/auth/session", { signal: controller.signal })
      .then(result => applyLiveSession(result, request))
      .catch(async error => {
        if (controller.signal.aborted || epoch.current !== request) return;
        if (await recoverOffline(error, request)) return;
        if (controller.signal.aborted || epoch.current !== request) return;
        setError(error instanceof ApiFailure ? error.message :
          "تعذر الاتصال. إذا لم تحفظ جلسة على هذا الجهاز، اتصل بالإنترنت وسجّل الدخول مرة واحدة.");
        setLoading(false);
      });
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, []);
  useEffect(() => {
    if (!offlineMode) return;
    const reconnect = () => { void reloadSession().catch(() => {}); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [offlineMode]);
  const logout = async () => {
    ++epoch.current;
    await api("/auth/logout", { method: "POST" });
    await client.cancelQueries();
    client.clear();
    ++epoch.current;
    csrf = null;
    const prior=offlineUser();
    setOfflineUser(null);
    sharedIdentity(null);
    await clearOfflineSession().catch(() => {});
    if(prior!==null) await clearOfflineSharedGrants(prior).catch(()=>{});
    setOfflineMode(false);
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
        offlineMode,
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

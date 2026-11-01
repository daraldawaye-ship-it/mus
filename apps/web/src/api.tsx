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
import { authenticateOfflineAccount, clearOfflineSession, enrollOfflineAccount, offlineLoginRequired, readOfflineSession, rememberRead, savedRead, saveOfflineSession, setOfflineLoginRequired, setOfflineUser } from "./offline-storage";
import { clearOfflineSharedGrants, lookupDownloadedDoctors, restoreOfflineSharedGrants, reuseAuthorizedRead, shareAuthorizedRead, sharedIdentity } from "./offline-shared";
import { lookupSharedItem } from "./offline-shared-items";
import { isOfflineNow, markNetworkFailure, markNetworkSuccess } from "./connection-mode";
import { readApiJson, UnexpectedApiResponse } from "./api-response";
import { offlineUser } from "./offline-storage";
import { allowPasswordAutofillOnDevice } from "./device-login-policy";
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
let freshOnlineLoginRequired = false;
export function sessionRequiresLogin(): boolean { return freshOnlineLoginRequired; }
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const mutation = method !== "GET" && method !== "HEAD";
  // A manual offline switch uses the same user-authorized read cache as
  // a physical outage. Never send new financial mutations while offline.
  async function fallbackRead(): Promise<T | undefined> {
    if (method !== "GET" || options.signal?.aborted) return undefined;
    const offline = await savedRead<T>(path).catch(() => undefined);
    if (offline !== undefined) return offline;
    const reusable = await reuseAuthorizedRead<T>(path).catch(() => undefined);
    if (reusable !== undefined) return reusable;
    const id = offlineUser();
    if (id===null) return undefined;
    const doctors=await lookupDownloadedDoctors<T>(path,id).catch(()=>undefined);
    if(doctors!==undefined) return doctors;
    return lookupSharedItem<T>(path,id).catch(() => undefined);
  }
  // A disconnected employee may switch locally, but the old employee\'s
  // server cookie must never issue reads or writes on their behalf.
  if (freshOnlineLoginRequired && path !== "/auth/login" && path !== "/auth/register") {
    const saved = await fallbackRead();
    if (saved !== undefined) return saved;
    throw new TypeError("يرجى تسجيل الدخول عبر الإنترنت لاستعادة الاتصال ومزامنة العمليات.");
  }
  if (isOfflineNow()) {
    const saved = await fallbackRead();
    if (saved !== undefined) return saved;
    throw new TypeError("وضع دون إنترنت: هذه العملية غير متاحة حتى عودة الاتصال.");
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: path.startsWith("/auth/") ? "no-store" : "default",
      signal: options.signal,
      headers: {
        "Accept": "application/json",
        ...(mutation ? { "Content-Type": "application/json" } : {}),
        ...(mutation && csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch (error) {
    // A canceled query is not an outage. Only transport failures switch modes.
    if (!options.signal?.aborted && error instanceof TypeError) markNetworkFailure();
    const saved = await fallbackRead();
    if (saved !== undefined) return saved;
    throw error;
  }
  let data: unknown;
  try {
    data = await readApiJson(response);
  } catch (error) {
    if (!(error instanceof UnexpectedApiResponse)) throw error;
    // A proxy/maintenance HTML page must not be treated as a successful
    // login, a wrong password or a valid API payload. The local authenticated
    // offline path can still be used if this device was enrolled previously.
    markNetworkFailure();
    const saved = await fallbackRead();
    if (saved !== undefined) return saved;
    throw new ApiFailure(
      error.message,
      response.status >= 500 ? response.status : 503,
      "invalid_api_response",
    );
  }
  markNetworkSuccess();
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
  loginWithPassword: (login: string, password: string) => Promise<void>;
  acceptRegistration: (result: SessionResponse) => Promise<void>;
  requiresOnlineLogin: boolean;
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
  const [requiresOnlineLogin, setRequiresOnlineLogin] = useState(false);
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
    setRequiresOnlineLogin(false);
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
      // A temporary server failure (for example an upstream 503 while
      // Render restarts) is an outage, not an authentication rejection.
      if (error.status < 500) return false;
    }
    if (navigator.onLine && !(error instanceof TypeError) &&
        !(error instanceof ApiFailure && error.status >= 500)) return false;
    if (!allowPasswordAutofillOnDevice()) {
      // A shared desktop may retain user-scoped offline card snapshots but
      // must NEVER silently reopen the last employee on an offline restart.
      // An employee can still enter their password against the salted local
      // verifier. Installed phones retain existing offline resume behavior.
      if (epoch.current !== request) return false;
      csrf = null;
      setOfflineUser(null);
      sharedIdentity(null);
      setSession({user:null,csrf:null,pendingLogoutRedirect:false});
      setRequiresOnlineLogin(false);
      setOfflineMode(true);
      setError(null);
      setLoading(false);
      return true;
    }
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
    if (freshOnlineLoginRequired) throw new Error("يلزم تسجيل الدخول عبر الإنترنت لإتمام التبديل");
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
    void (async () => {
      const locked = await offlineLoginRequired().catch(() => true);
      if (controller.signal.aborted || epoch.current !== request) return;
      if (locked) {
        freshOnlineLoginRequired = true;
        const last = await readOfflineSession().catch(() => null);
        if (controller.signal.aborted || epoch.current !== request) return;
        csrf = null;
        setOfflineUser(last?.id ?? null);
        sharedIdentity(last?.id ?? null);
        if (last) await restoreOfflineSharedGrants(last.id).catch(() => {});
        if (controller.signal.aborted || epoch.current !== request) return;
        setSession({user:last,csrf:null,pendingLogoutRedirect:false});
        setRequiresOnlineLogin(!!last);
        setOfflineMode(!!last);
        setLoading(false);
        return;
      }
      try {
        const result = await api<SessionResponse>("/auth/session", { signal: controller.signal });
        await applyLiveSession(result, request);
      } catch (error) {
        if (controller.signal.aborted || epoch.current !== request) return;
        if (await recoverOffline(error, request)) return;
        if (controller.signal.aborted || epoch.current !== request) return;
        setError(error instanceof ApiFailure ? error.message :
          "تعذر الاتصال. إذا لم تحفظ جلسة على هذا الجهاز، اتصل بالإنترنت وسجّل الدخول مرة واحدة.");
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, []);
  useEffect(() => {
    if (!offlineMode) return;
    const reconnect = () => {
      if (!freshOnlineLoginRequired) void reloadSession().catch(() => {});
    };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [offlineMode]);
  async function adoptLiveAuthentication(result: SessionResponse): Promise<void> {
    if (!result.user || !result.csrf) throw new Error("لم يؤكد الخادم جلسة المستخدم");
    const request=++epoch.current;
    await client.cancelQueries();
    client.clear();
    await setOfflineLoginRequired(false);
    freshOnlineLoginRequired=false;
    if (epoch.current !== request) return;
    await applyLiveSession(result,request);
    window.dispatchEvent(new Event("alraesy-auth-restored"));
  }
  const acceptRegistration = async (result: SessionResponse) => {
    await adoptLiveAuthentication(result);
  };
  const loginWithPassword = async (login: string, password: string) => {
    const identity=login.trim();
    if (!identity || !password) throw new Error("أدخل الحساب وكلمة المرور");
    if (!isOfflineNow()) {
      try {
        const result=await api<SessionResponse>("/auth/login",{
          method:"POST",body:{
            ...(identity.includes("@") ? {email:identity} : {phone:identity}),password,
          },
        });
        await adoptLiveAuthentication(result);
        if (result.user) await enrollOfflineAccount(result.user,identity,password).catch(()=>{});
        return;
      } catch(error) {
        if (!(error instanceof TypeError) &&
            !(error instanceof ApiFailure && error.status >= 500)) throw error;
      }
    }
    // An offline login authenticates only against a previous successful
    // server login on this device; it never creates a server session.
    const offlineUserRecord=await authenticateOfflineAccount(identity,password);
    const request=++epoch.current;
    freshOnlineLoginRequired=true;
    await setOfflineLoginRequired(true);
    await client.cancelQueries();
    client.clear();
    await saveOfflineSession(offlineUserRecord);
    if (epoch.current!==request) return;
    csrf=null;
    setOfflineUser(offlineUserRecord.id);
    sharedIdentity(offlineUserRecord.id);
    await restoreOfflineSharedGrants(offlineUserRecord.id).catch(()=>{});
    if (epoch.current!==request) return;
    setSession({user:offlineUserRecord,csrf:null,pendingLogoutRedirect:false});
    setRequiresOnlineLogin(true);
    setOfflineMode(true);
    setError(null);
    setLoading(false);
  };
  const logout = async () => {
    ++epoch.current;
    let serverSignedOut = false;
    if (!isOfflineNow() && !freshOnlineLoginRequired) {
      try {
        await api("/auth/logout", { method: "POST" });
        serverSignedOut = true;
      } catch (error) {
        // A transport failure needs a local lock; a real HTTP rejection
        // cannot be treated as a completed logout.
        if (!(error instanceof TypeError)) throw error;
      }
    }
    // Only a local signout (or an offline employee switch) leaves a previous
    // server cookie usable. A confirmed online logout revoked that cookie,
    // so OAuth and ordinary online login must remain available as before.
    freshOnlineLoginRequired = !serverSignedOut;
    await setOfflineLoginRequired(!serverSignedOut,true);
    await client.cancelQueries();
    client.clear();
    ++epoch.current;
    csrf = null;
    setOfflineUser(null);
    sharedIdentity(null);
    // Keep previously authorized reference downloads for this account so it
    // can be used again only after the employee proves their password locally.
    // In-memory grants are cleared by sharedIdentity(null) above; a denied
    // server session still revokes persisted grants in recoverOffline().
    setOfflineMode(false);
    setRequiresOnlineLogin(false);
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
        loginWithPassword,
        acceptRegistration,
        requiresOnlineLogin,
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
  options: { pageSizes?: readonly number[]; staleTime?: number } = {},
) {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const allowedPageSizes = options.pageSizes ?? [10, 20, 50, 100];
  const requestedPageSize = Number(params.get("pageSize"));
  const pageSize = allowedPageSizes.includes(requestedPageSize)
    ? requestedPageSize
    : allowedPageSizes.includes(20) ? 20 : allowedPageSizes[0];
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
    // Previously visited pages are available immediately until they become
    // stale. Invalidation after a stock/accounting write still forces refresh.
    staleTime: options.staleTime ?? 0,
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
    dataLoaded: result.data !== undefined,
    error: result.error,
    query,
    page,
    pageSize,
    sorting,
    setQuery: (value: string) => write({ q: value || null, page: null }),
    setPage: (value: number) => write({ page: String(value) }),
    setPageSize: (value: number) => {
      if (allowedPageSizes.includes(value))
        write({ pageSize: String(value), page: null });
    },
    setSorting,
    refetch: result.refetch,
  };
}

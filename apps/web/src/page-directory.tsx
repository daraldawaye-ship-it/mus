import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, useSession } from "./api";
import { Button, Card, Notice } from "./ui";
import { errorMessage } from "./phase2";
import type {
  PageDirectory,
  PageEntry,
  ResolvedPage,
} from "../../../packages/contracts/src/index";

export function usePageDirectory(companyId?: number) {
  const { user } = useSession();
  return useQuery({
    queryKey: ["page-directory", user?.id, companyId ?? null],
    queryFn: async ({ signal }) => {
      let page = 1;
      const entries: PageEntry[] = [];
      while (true) {
        const query = new URLSearchParams({
          page: String(page),
          pageSize: "100",
          sort: "order:asc",
        });
        if (companyId) query.set("companyId", String(companyId));
        const response = await api<PageDirectory>(`/page-catalog?${query}`, {
          signal,
        });
        entries.push(...response.items);
        if (entries.length >= response.total || !response.items.length)
          return entries;
        page++;
      }
    },
    enabled: !!user,
    networkMode: "always",
    staleTime: 10_000,
  });
}
export function PageRouteGuard({
  pageKey,
  companyId,
  children,
}: {
  pageKey?: string;
  companyId?: number;
  children: React.ReactNode;
}) {
  const { user } = useSession();
  const route = useLocation();
  const queryClient = useQueryClient();
  const visitedRoute = useRef<string | null>(null);
  const catalog = usePageDirectory(companyId);
  // Once open, keep the editor mounted so a remote flag change cannot discard
  // its unsaved or uncertain request. Each data/action request remains gated.
  const [admitted, setAdmitted] = useState(false);
  const entry = catalog.data?.find((entry) => entry.key === pageKey);
  const allowed = !!entry?.actionAccess.view;
  useEffect(() => {
    if (allowed) setAdmitted(true);
  }, [allowed]);
  useEffect(() => {
    if (!user || !companyId || !pageKey || !admitted || !allowed) return;
    const visit = `${user.id}:${companyId}:${pageKey}:${route.pathname}`;
    if (visitedRoute.current === visit) return;
    visitedRoute.current = visit;
    // Only actual admitted route transitions register visits. Refetching page
    // data and background API polling never execute this effect.
    void api<{ rewarded: boolean }>(
      `/companies/${companyId}/reward-events/page-visit`,
      {
        method: "POST",
        body: { pageKey, idempotencyKey: crypto.randomUUID() },
      },
    )
      .then((result) => {
        if (result.rewarded) {
          void queryClient.invalidateQueries({
            queryKey: ["wallet-summary", user.id, companyId],
          });
          void queryClient.invalidateQueries({
            queryKey: ["list", user.id, `company:${companyId}:wallet`],
          });
        }
      })
      .catch(() => {});
  }, [
    user?.id,
    companyId,
    pageKey,
    route.pathname,
    admitted,
    allowed,
    queryClient,
  ]);
  if (!user || !pageKey || admitted) return children;
  if (catalog.error)
    return (
      <Notice tone="error">
        {errorMessage(catalog.error)}{" "}
        <Button variant="ghost" onClick={() => void catalog.refetch()}>
          إعادة المحاولة
        </Button>
      </Notice>
    );
  if (!catalog.data)
    return <Notice>جارٍ التحقق من إتاحة الصفحة والصلاحيات…</Notice>;
  if (!allowed)
    return (
      <Card title={entry?.name ?? "الصفحة غير متاحة"}>
        <Notice tone="warning">
          {entry && !entry.enabled
            ? "هذه الصفحة معطلة. راجع مسؤول النطاق."
            : "لا تملك الصلاحية المطلوبة لفتح هذه الصفحة."}
        </Notice>
        <Link
          className="button button-secondary"
          to={companyId ? `/companies/${companyId}/pages` : "/pages"}
        >
          قائمة الصفحات
        </Link>
      </Card>
    );
  return children;
}
export function PageReferenceRedirect() {
  const { pageKey } = useParams(),
    [params] = useSearchParams(),
    { user } = useSession();
  const query = new URLSearchParams();
  for (const field of ["companyId", "recordId"])
    if (params.has(field)) query.set(field, params.get(field)!);
  const result = useQuery({
    queryKey: ["page-reference", user?.id, pageKey, query.toString()],
    enabled: !!user && !!pageKey,
    queryFn: ({ signal }) =>
      api<ResolvedPage>(
        `/page-catalog/${encodeURIComponent(pageKey!)}/resolve?${query}`,
        { signal },
      ),
  });
  if (result.error)
    return (
      <Card title="تعذر فتح مرجع الصفحة">
        <Notice tone="error">{errorMessage(result.error)}</Notice>
        <Link className="button button-secondary" to="/pages">
          قائمة الصفحات
        </Link>
      </Card>
    );
  if (!result.data)
    return <Notice>جارٍ التحقق من مرجع الصفحة والشركة والسجل…</Notice>;
  return <Navigate to={result.data.href} replace />;
}

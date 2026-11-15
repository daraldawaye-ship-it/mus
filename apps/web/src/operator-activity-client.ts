import type { OperatorActivityPageKey } from "../../../packages/contracts/src/operator-activity";
import { api } from "./api";

export function operatorActivityOrigin(pathname: string): {companyId: number | null; pageKey: OperatorActivityPageKey} {
  const scoped = /^\/companies\/([1-9]\d*)(?:\/([^/]+))?\/?/.exec(pathname);
  if (scoped) {
    const companyId = Number(scoped[1]);
    const view = scoped[2];
    const pageKey: OperatorActivityPageKey = !view ? "company.overview" :
      ["sales", "purchases", "invoice", "purchase-line-movements", "legacy-sales-import"].includes(view) ? "company.invoice" :
      view === "chat" ? "company.chat" : view === "notifications" ? "company.notifications" :
      ["items", "item", "item-compositions", "item-shelves", "item-agents"].includes(view) ? "company.items" :
      ["stock-balances", "stock-movements", "stock-operations", "stock-adjustments"].includes(view) ? "company.inventory" :
      view === "accounts" ? "company.accounts" : view === "employees" ? "company.employees" :
      view.startsWith("attendance") ? "company.attendance" : "company.other";
    return { companyId, pageKey };
  }
  const pageKey: OperatorActivityPageKey = pathname === "/" || /^\/medicine-market(?:\/|$)/.test(pathname)
    ? "public.medicine_market" : pathname === "/companies" ? "public.companies" :
      pathname === "/chat" ? "public.chat" : pathname === "/notifications" ? "public.notifications" :
      pathname === "/profile" ? "public.profile" : pathname === "/tasks" ? "public.tasks" :
      pathname.startsWith("/legal-cases") ? "public.legal_cases" :
      pathname.startsWith("/general-table") ? "public.general_table" : "public.other";
  return { companyId: null, pageKey };
}

export function sendOperatorActivity(actorId: number, pathname: string, input: {
  surface: "avatar_menu" | "operator_search"; actionKey: string; detailKey?: string; searchText?: string;
}, visitorId: string): void {
  if (!navigator.onLine) return;
  // No cross-account retry queue. The server rejects if the cookie's current
  // actor is not this expected actor, and derives employee identity itself.
  void api("/interest-events", { method:"POST", body:{visitorId,events:[
    {id:crypto.randomUUID(),actorId,...operatorActivityOrigin(pathname),...input},
  ]}}).catch(() => {});
}

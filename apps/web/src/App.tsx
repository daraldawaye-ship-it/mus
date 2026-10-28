import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Bell,
  BookOpen,
  ChevronLeft,
  CircleUserRound,
  Coins,
  FileClock,
  FileText,
  ListChecks,
  HandCoins,
  Landmark,
  Wallet,
  Home,
  TableProperties,
  LayoutDashboard,
  ListTree,
  LogIn,
  Menu,
  MapPin,
  Package,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Users,
  Warehouse,
} from "lucide-react";
import type {
  CompanyContext,
  CompanyPage,
} from "../../../packages/contracts/src/index";
import { api, SessionProvider, useSession } from "./api";
import {
  pageKeyForLocation,
  pageDefinitions,
  pageHref,
  pageRuleAllows,
} from "../../../packages/contracts/src/index";
import {
  PageRouteGuard,
  PageReferenceRedirect,
  usePageDirectory,
} from "./page-directory";
import { AppearanceButton, AppearanceProvider } from "./theme";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "./NotificationBell";
import { WalletIndicator } from "./WalletIndicator";
import { Button, Card, Dialog, Notice } from "./ui";
import {
  AuthPage,
  HomePage,
  ProfilePage,
  PublicAuditPage,
  UsersPage,
} from "./pages/PublicPages";
import {
  CompaniesPage,
  CompanyAuditPage,
  CompanyOverviewPage,
  CompanySettingsPage,
  EmployeesPage,
} from "./pages/CompanyPages";

const PageDirectoryPage = lazy(() =>
  import("./pages/PageDirectoryPage").then((module) => ({
    default: module.PageDirectoryPage,
  })),
);
const GeneralTablePage = lazy(() =>
  import("./pages/GeneralTablePage").then((module) => ({
    default: module.GeneralTablePage,
  })),
);
const ConfigurationPage = lazy(() =>
  import("./pages/ConfigurationPage").then((module) => ({
    default: module.ConfigurationPage,
  })),
);
const AttendancePage = lazy(() =>
  import("./pages/AttendancePage").then((module) => ({
    default: module.AttendancePage,
  })),
);
const WalletPage = lazy(() =>
  import("./pages/WalletPage").then((module) => ({
    default: module.WalletPage,
  })),
);
const RewardTasksPage = lazy(() =>
  import("./pages/WalletPage").then((module) => ({
    default: module.RewardTasksPage,
  })),
);
const WalletSettingsPage = lazy(() =>
  import("./pages/WalletSettingsPage").then((module) => ({
    default: module.WalletSettingsPage,
  })),
);
const WalletConversionsPage = lazy(() =>
  import("./pages/WalletConversionsPage").then((module) => ({
    default: module.WalletConversionsPage,
  })),
);
const NotificationsPage = lazy(() =>
  import("./pages/NotificationsPage").then((module) => ({
    default: module.NotificationsPage,
  })),
);
const NotificationTemplatesPage = lazy(() =>
  import("./pages/NotificationsPage").then((module) => ({
    default: module.NotificationTemplatesPage,
  })),
);
const MemosPage = lazy(() =>
  import("./pages/MemosPage").then((module) => ({ default: module.MemosPage })),
);
const QuestionsPage = lazy(() =>
  import("./pages/QuestionsPage").then((module) => ({ default: module.QuestionsPage })),
);
const MemoDetailPage = lazy(() =>
  import("./pages/MemosPage").then((module) => ({ default: module.MemoDetailPage })),
);
const AccountsPage = lazy(() =>
  import("./pages/AccountsPage").then((module) => ({
    default: module.AccountsPage,
  })),
);
const CurrenciesPage = lazy(() =>
  import("./pages/MoneyPages").then((module) => ({
    default: module.CurrenciesPage,
  })),
);
const ExchangeRatesPage = lazy(() =>
  import("./pages/MoneyPages").then((module) => ({
    default: module.ExchangeRatesPage,
  })),
);
const BranchesPage = lazy(() =>
  import("./pages/LocationPages").then((module) => ({
    default: module.BranchesPage,
  })),
);
const LocationsPage = lazy(() =>
  import("./pages/LocationPages").then((module) => ({
    default: module.LocationsPage,
  })),
);
const FinancialDocumentsPage = lazy(() =>
  import("./pages/FinancePages").then((module) => ({
    default: module.FinancialDocumentsPage,
  })),
);
const FinanceDocumentPage = lazy(() =>
  import("./pages/FinancePages").then((module) => ({
    default: module.FinanceDocumentPage,
  })),
);
const AccountBalancesPage = lazy(() =>
  import("./pages/FinancePages").then((module) => ({
    default: module.AccountBalancesPage,
  })),
);
const AccountLedgerPage = lazy(() =>
  import("./pages/FinancePages").then((module) => ({
    default: module.AccountLedgerPage,
  })),
);
const ItemsPage = lazy(() =>
  import("./pages/ItemsPages").then((module) => ({
    default: module.ItemsPage,
  })),
);
const ItemPage = lazy(() =>
  import("./pages/ItemsPages").then((module) => ({ default: module.ItemPage })),
);
const ItemShelvesPage = lazy(() =>
  import("./pages/ItemShelvesPage").then(module => ({
    default: module.ItemShelvesPage,
  })),
);
const ItemCompositionsPage = lazy(() =>
  import("./pages/ItemCompositionsPage").then((module) => ({
    default: module.ItemCompositionsPage,
  })),
);
const ItemAgentsPage = lazy(() =>
  import("./pages/ItemsPages").then((module) => ({
    default: module.ItemAgentsPage,
  })),
);
const InventoryBalancesPage = lazy(() =>
  import("./pages/InventoryPages").then((module) => ({
    default: module.InventoryBalancesPage,
  })),
);
const InventoryMovementsPage = lazy(() =>
  import("./pages/InventoryPages").then((module) => ({
    default: module.InventoryMovementsPage,
  })),
);
const InventoryOperationsPage = lazy(() =>
  import("./pages/InventoryPages").then((module) => ({
    default: module.InventoryOperationsPage,
  })),
);
const InventoryAdjustmentsPage = lazy(() =>
  import("./pages/InventoryPages").then((module) => ({
    default: module.InventoryAdjustmentsPage,
  })),
);
const InventorySettingsPage = lazy(() =>
  import("./pages/InventoryPages").then((module) => ({
    default: module.InventorySettingsPage,
  })),
);
const InvoicesPage = lazy(() =>
  import("./pages/CommercePages").then((module) => ({
    default: module.InvoicesPage,
  })),
);
const InvoicePage = lazy(() =>
  import("./pages/CommercePages").then((module) => ({
    default: module.InvoicePage,
  })),
);
const companySections = [
  "notifications",
  "notification-templates",
  "memos",
  "memo-detail",
  "questions",
  "answers",
  "attendance",
  "wallet",
  "reward-tasks",
  "wallet-settings",
  "wallet-conversions",
  "pages",
  "configuration",
  "overview",
  "employees",
  "settings",
  "audit",
  "accounts",
  "currencies",
  "exchange-rates",
  "branches",
  "locations",
  "financial-documents",
  "financial-document",
  "journals",
  "receipts",
  "payments",
  "account-balances",
  "account-ledger",
  "items",
  "item",
  "item-agents",
  "item-compositions",
  "item-shelves",
  "stock-balances",
  "stock-movements",
  "stock-operations",
  "stock-adjustments",
  "inventory-settings",
  "purchases",
  "sales",
  "invoice",
] as const;
type CompanySection = (typeof companySections)[number];

function Navigation({
  context,
  close,
}: {
  context?: CompanyContext;
  close?: () => void;
}) {
  const { user } = useSession();
  const directory = usePageDirectory(context?.company.id);
  const entries =
    directory.data ??
    pageDefinitions.map((definition) => ({
      ...definition,
      href: pageHref(definition, context?.company.id),
      enabled: true,
      actionAccess: {
        view: pageRuleAllows(definition.actions.view, user, context),
      },
    }));
  const icons: Record<string, React.ReactNode> = {
    "public.home": <Home size={17} />,
    "public.profile": <CircleUserRound size={17} />,
    "public.companies": <Building2 size={17} />,
    "public.users": <Users size={17} />,
    "public.general-table": <TableProperties size={17} />,
    "public.audit": <FileClock size={17} />,
    "public.notifications": <Bell size={17} />,
    "public.notification-templates": <Settings2 size={17} />,
    "company.overview": <LayoutDashboard size={17} />,
    "company.configuration": <ShieldCheck size={17} />,
    "company.employees": <Users size={17} />,
    "company.attendance": <FileClock size={17} />,
    "company.wallet": <Wallet size={17} />,
    "company.reward-tasks": <Coins size={17} />,
    "company.wallet-settings": <Wallet size={17} />,
    "company.wallet-conversions": <Wallet size={17} />,
    "company.notifications": <Bell size={17} />,
    "company.notification-templates": <Settings2 size={17} />,
    "company.memos": <FileText size={17} />,
    "company.questions": <ListChecks size={17} />,
    "company.answers": <ListChecks size={17} />,
    "public.questions": <ListChecks size={17} />,
    "public.answers": <ListChecks size={17} />,
    "company.settings": <Settings2 size={17} />,
    "company.accounts": <BookOpen size={17} />,
    "company.items": <Package size={17} />,
    "company.item-agents": <Users size={17} />,
    "company.item-compositions": <Package size={17} />,
    "company.item-shelves": <Package size={17} />,
    "company.stock-balances": <Warehouse size={17} />,
    "company.stock-movements": <FileText size={17} />,
    "company.stock-operations": <Package size={17} />,
    "company.stock-adjustments": <Package size={17} />,
    "company.inventory-settings": <Settings2 size={17} />,
    "company.sales": <FileText size={17} />,
    "company.purchases": <FileText size={17} />,
    "company.financial-documents": <FileText size={17} />,
    "company.journals": <BookOpen size={17} />,
    "company.receipts": <HandCoins size={17} />,
    "company.payments": <Wallet size={17} />,
    "company.account-balances": <Landmark size={17} />,
    "company.account-ledger": <FileText size={17} />,
    "company.currencies": <Coins size={17} />,
    "company.exchange-rates": <TrendingUp size={17} />,
    "company.branches": <MapPin size={17} />,
    "company.locations": <Warehouse size={17} />,
    "company.audit": <FileClock size={17} />,
  };
  const links = (scope: "public" | "company") =>
    [...entries]
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      .filter(
        (entry) =>
          entry.scope === scope &&
          entry.navigation &&
          entry.href &&
          entry.visible &&
          entry.enabled &&
          entry.actionAccess.view,
      )
      .map((entry) => (
        <NavLink
          key={entry.key}
          to={entry.href!}
          aria-label={entry.name}
          title={entry.name}
          end={["public.home", "public.companies", "company.overview"].includes(
            entry.key,
          )}
          onClick={close}
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          {icons[entry.key] ?? <ListTree size={17} />}
          <span className="nav-text">{entry.name}</span>
          <ChevronLeft size={13} className="nav-chevron" />
        </NavLink>
      ));
  return (
    <nav aria-label="التنقل الرئيسي">
      <div className="nav-label nav-heading">الموقع العام</div>
      {links("public")}
      {!user && (
        <NavLink
          to="/login"
          onClick={close}
          className="nav-link"
          aria-label="تسجيل الدخول"
          title="تسجيل الدخول"
        >
          <LogIn size={17} />
          <span className="nav-text">تسجيل الدخول</span>
        </NavLink>
      )}
      {context && (
        <>
          <div className="nav-label nav-heading company-nav-label">
            {context.company.name}
          </div>
          {links("company")}
        </>
      )}
    </nav>
  );
}
function CompanyView({
  context,
  loading,
  error,
  section,
}: {
  context?: CompanyContext;
  loading: boolean;
  error: Error | null;
  section: CompanySection;
}) {
  const location = useLocation();
  const { user } = useSession();
  if (loading && !context)
    return (
      <Card>
        <Notice>جارٍ تحميل الشركة والتحقق من الوصول…</Notice>
      </Card>
    );
  if (error)
    return (
      <Card>
        <Notice tone="error">{error.message}</Notice>
        <NavLink className="button button-secondary" to="/companies">
          العودة للشركات
        </NavLink>
      </Card>
    );
  if (!context) return <Notice tone="error">تعذر العثور على الشركة.</Notice>;
  const pageKey = section === "memo-detail" ? "company.memo-detail" : pageKeyForLocation(location.pathname, location.search);
  return (
    <PageRouteGuard
      key={`${user?.id}:${context.company.id}:${pageKey}`}
      pageKey={pageKey}
      companyId={context.company.id}
    >
      <CompanyContent context={context} section={section} />
    </PageRouteGuard>
  );
}
function CompanyContent({
  context,
  section,
}: {
  context: CompanyContext;
  section: CompanySection;
}) {
  switch (section) {
    case "questions":
    case "answers":
      return <Suspense fallback={<Notice>جارٍ تحميل الأسئلة…</Notice>}>
        <QuestionsPage key={context.company.id} companyId={context.company.id} tab={section} />
      </Suspense>;
    case "memos":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المذكرات…</Notice>}>
          <MemosPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "memo-detail":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المذكرة…</Notice>}>
          <MemoDetailPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "notifications":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل التنبيهات…</Notice>}>
          <NotificationsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "notification-templates":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل أنواع التنبيهات…</Notice>}>
          <NotificationTemplatesPage
            key={context.company.id}
            context={context}
          />
        </Suspense>
      );
    case "attendance":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الحضور والانصراف…</Notice>}>
          <AttendancePage key={context.company.id} context={context} />
        </Suspense>
      );
    case "wallet":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل النقاط والمحفظة…</Notice>}>
          <WalletPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "reward-tasks":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل مهام المكافآت…</Notice>}>
          <RewardTasksPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "wallet-settings":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل إعدادات المحفظة…</Notice>}>
          <WalletSettingsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "wallet-conversions":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل تحويلات النقاط…</Notice>}>
          <WalletConversionsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "pages":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل قائمة الصفحات…</Notice>}>
          <PageDirectoryPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "configuration":
      return (
        <Suspense
          fallback={<Notice>جارٍ تحميل إدارة الخيارات والصلاحيات…</Notice>}
        >
          <ConfigurationPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "employees":
      return <EmployeesPage key={context.company.id} context={context} />;
    case "settings":
      return <CompanySettingsPage key={context.company.id} context={context} />;
    case "audit":
      return <CompanyAuditPage key={context.company.id} context={context} />;
    case "accounts":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل دليل الحسابات…</Notice>}>
          <AccountsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "items":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الأصناف…</Notice>}>
          <ItemsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "item":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل كرت الصنف…</Notice>}>
          <ItemPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "item-shelves":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل كروت الرفوف…</Notice>}>
          <ItemShelvesPage key={context.company.id} context={context}/>
        </Suspense>
      );
    case "item-compositions":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل تراكيب الأصناف…</Notice>}>
          <ItemCompositionsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "item-agents":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الوكلاء…</Notice>}>
          <ItemAgentsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "stock-balances":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل أرصدة المخزون…</Notice>}>
          <InventoryBalancesPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "stock-movements":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل حركات المخزون…</Notice>}>
          <InventoryMovementsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "stock-operations":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المناقلات…</Notice>}>
          <InventoryOperationsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "stock-adjustments":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل تسوية الأصناف…</Notice>}>
          <InventoryAdjustmentsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "inventory-settings":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل إعداد المخزون…</Notice>}>
          <InventorySettingsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "purchases":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل فواتير المشتريات…</Notice>}>
          <InvoicesPage
            key={`${context.company.id}:purchase`}
            context={context}
            kind="purchase"
          />
        </Suspense>
      );
    case "invoice":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الفاتورة…</Notice>}>
          <InvoicePage key={context.company.id} context={context} />
        </Suspense>
      );
    case "sales":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل فواتير المبيعات…</Notice>}>
          <InvoicesPage
            key={`${context.company.id}:sale`}
            context={context}
            kind="sale"
          />
        </Suspense>
      );
    case "financial-documents":
    case "journals":
    case "receipts":
    case "payments":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل العمليات المالية…</Notice>}>
          <FinancialDocumentsPage
            key={`${context.company.id}:${section}`}
            context={context}
            kind={
              section === "journals"
                ? "journal"
                : section === "receipts"
                  ? "receipt"
                  : section === "payments"
                    ? "payment"
                    : undefined
            }
          />
        </Suspense>
      );
    case "financial-document":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المستند…</Notice>}>
          <FinanceDocumentPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "account-balances":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الأرصدة…</Notice>}>
          <AccountBalancesPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "account-ledger":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل كشف الحساب…</Notice>}>
          <AccountLedgerPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "currencies":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل العملات…</Notice>}>
          <CurrenciesPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "exchange-rates":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل أسعار الصرف…</Notice>}>
          <ExchangeRatesPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "branches":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الفروع…</Notice>}>
          <BranchesPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "locations":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المعارض والمخازن…</Notice>}>
          <LocationsPage key={context.company.id} context={context} />
        </Suspense>
      );
    default:
      return <CompanyOverviewPage context={context} />;
  }
}
function Protected({ children }: { children: React.ReactNode }) {
  const { user, pendingLogoutRedirect } = useSession();
  return user ? (
    children
  ) : (
    <Navigate to={pendingLogoutRedirect ? "/" : "/login"} replace />
  );
}
function Workspace() {
  const {
    user,
    loading: sessionLoading,
    error: sessionError,
    logout,
    pendingLogoutRedirect,
    acknowledgeLogoutRedirect,
  } = useSession();
  const match = useMatch("/companies/:companyId/*");
  const companyId = Number(match?.params.companyId);
  const inCompany = Number.isSafeInteger(companyId) && companyId > 0;
  const scope = inCompany ? `company:${companyId}` : "public";
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const main = useRef<HTMLElement>(null);
  const priorPath = useRef(location.pathname);
  const company = useQuery({
    queryKey: ["company", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<CompanyContext>(`/companies/${companyId}`, { signal }),
    enabled: !!user && inCompany,
    staleTime: 0,
  });
  // The backend persists the last accessible company for each user. Resolve it
  // independently from the current route so public pages retain company links.
  const lastCompany = useQuery({
    queryKey: ["last-company-sidebar", user?.id],
    queryFn: async ({ signal }) => {
      const list = await api<CompanyPage>("/companies?pageSize=1", { signal });
      if (!list.lastCompanyId) return null;
      return api<CompanyContext>(`/companies/${list.lastCompanyId}`, {
        signal,
      });
    },
    enabled: !!user && !inCompany,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  const navigationContext = inCompany
    ? company.isError
      ? undefined
      : company.data
    : lastCompany.isError
      ? undefined
      : (lastCompany.data ?? undefined);
  useEffect(() => {
    setDrawer(false);
    if (priorPath.current !== location.pathname) {
      priorPath.current = location.pathname;
      main.current?.focus({ preventScroll: true });
    }
  }, [location.pathname]);
  useEffect(() => {
    if (!user && pendingLogoutRedirect && location.pathname === "/") {
      acknowledgeLogoutRedirect();
    }
  }, [
    user,
    pendingLogoutRedirect,
    location.pathname,
    acknowledgeLogoutRedirect,
  ]);
  useEffect(() => {
    if (!user || !inCompany || !company.data || company.isError) return;
    const controller = new AbortController();
    const userId = user.id;
    const selectedContext = company.data;
    void api(`/companies/${companyId}/activate`, {
      method: "POST",
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted) {
          queryClient.setQueryData(
            ["last-company-sidebar", userId],
            selectedContext,
          );
          void queryClient.invalidateQueries({
            queryKey: ["wallet-summary", userId, companyId],
          });
          void queryClient.invalidateQueries({
            queryKey: ["list", userId, `company:${companyId}:wallet`],
          });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [companyId, user?.id, !!company.data, company.isError, queryClient]);
  if (sessionLoading)
    return (
      <div className="boot-state">
        <span className="brand-symbol">ت</span>
        <p>جارٍ تحميل مساحة العمل…</p>
      </div>
    );
  return (
    <AppearanceProvider key={`${user?.id ?? "guest"}:${scope}`} scope={scope}>
      <div className="workspace">
        <aside
          id="desktop-navigation"
          className="sidebar"
          aria-label="قائمة التنقل"
        >
          <NavLink
            to="/"
            className="brand"
            aria-label="تجارة — الموقع العام"
            title="تجارة — الموقع العام"
          >
            <span className="brand-symbol">ت</span>
            <span className="brand-copy">
              تجارة<small>مساحة العمل</small>
            </span>
          </NavLink>
          <Navigation context={navigationContext} />
          <div className="sidebar-bottom">
            <ShieldCheck size={17} />
            <span>
              {user?.owner
                ? "مالك المنصة"
                : user
                  ? "حساب عام مستقل"
                  : "مساحة أعمال منظمة"}
            </span>
          </div>
        </aside>
        <div className="workspace-body">
          <header className="topbar">
            <div className="topbar-start">
              <Button
                variant="ghost"
                className="mobile-menu"
                aria-label="فتح قائمة التنقل"
                aria-expanded={drawer}
                onClick={() => setDrawer(true)}
              >
                <Menu size={20} />
              </Button>
              <div className="scope-title">
                <span className="scope-mark">
                  <Building2 size={16} />
                </span>
                <div>
                  <strong>
                    {company.data?.company.name ?? "الموقع العام"}
                  </strong>
                </div>
              </div>
            </div>
            <div className="topbar-actions">
              {user && inCompany && company.data && !company.isError && (
                <WalletIndicator
                  key={`${user.id}:${scope}`}
                  context={company.data}
                />
              )}
              {user && (
                <NotificationBell
                  key={`${user.id}:${scope}`}
                  companyId={
                    inCompany && company.data && !company.isError
                      ? companyId
                      : undefined
                  }
                />
              )}
              {user ? (
                <UserMenu
                  user={user}
                  onLogout={() => {
                    setLogoutError("");
                    void logout()
                      .then(() => navigate("/", { replace: true }))
                      .catch((error) =>
                        setLogoutError(
                          error instanceof Error
                            ? error.message
                            : "تعذر تسجيل الخروج",
                        ),
                      );
                  }}
                />
              ) : (
                <>
                  <AppearanceButton />
                  <NavLink
                    className="button button-secondary desktop-only"
                    to="/login"
                  >
                    تسجيل الدخول
                  </NavLink>
                </>
              )}
            </div>
          </header>
          <main className="main-content" ref={main} tabIndex={-1}>
            {sessionError && <Notice tone="error">{sessionError}</Notice>}
            {logoutError && <Notice tone="error">{logoutError}</Notice>}
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              <Route path="/questions" element={<Protected><PageRouteGuard pageKey="public.questions"><Suspense fallback={<Notice>جارٍ تحميل الأسئلة…</Notice>}><QuestionsPage /></Suspense></PageRouteGuard></Protected>} />
              <Route path="/answers" element={<Protected><PageRouteGuard pageKey="public.answers"><Suspense fallback={<Notice>جارٍ تحميل الإجابات…</Notice>}><QuestionsPage tab="answers" /></Suspense></PageRouteGuard></Protected>} />
              <Route
                path="/notifications"
                element={
                  <Protected>
                    <PageRouteGuard pageKey="public.notifications">
                      <Suspense
                        fallback={<Notice>جارٍ تحميل التنبيهات…</Notice>}
                      >
                        <NotificationsPage />
                      </Suspense>
                    </PageRouteGuard>
                  </Protected>
                }
              />
              <Route
                path="/notification-templates"
                element={
                  <Protected>
                    <PageRouteGuard pageKey="public.notification-templates">
                      <Suspense
                        fallback={<Notice>جارٍ تحميل أنواع التنبيهات…</Notice>}
                      >
                        <NotificationTemplatesPage />
                      </Suspense>
                    </PageRouteGuard>
                  </Protected>
                }
              />
              <Route
                path="/pages"
                element={
                  <Protected>
                    <Suspense
                      fallback={<Notice>جارٍ تحميل قائمة الصفحات…</Notice>}
                    >
                      <PageDirectoryPage />
                    </Suspense>
                  </Protected>
                }
              />
              <Route
                path="/go/:pageKey"
                element={
                  <Protected>
                    <PageReferenceRedirect />
                  </Protected>
                }
              />
              <Route
                path="/profile"
                element={
                  <Protected>
                    <ProfilePage />
                  </Protected>
                }
              />
              <Route
                path="/users"
                element={
                  <Protected>
                    <PageRouteGuard pageKey="public.users">
                      <UsersPage />
                    </PageRouteGuard>
                  </Protected>
                }
              />
              <Route
                path="/general-table"
                element={
                  <Protected>
                    <Suspense
                      fallback={<Notice>جارٍ تحميل الجدول العام…</Notice>}
                    >
                      <PageRouteGuard pageKey="public.general-table">
                        <GeneralTablePage />
                      </PageRouteGuard>
                    </Suspense>
                  </Protected>
                }
              />
              <Route
                path="/audit"
                element={
                  <Protected>
                    <PageRouteGuard pageKey="public.audit">
                      <PublicAuditPage />
                    </PageRouteGuard>
                  </Protected>
                }
              />
              <Route
                path="/companies"
                element={
                  <Protected>
                    <CompaniesPage />
                  </Protected>
                }
              />
              {companySections.map((section) => (
                <Route
                  key={section}
                  path={`/companies/:companyId${section === "overview" ? "" : section === "memo-detail" ? "/memos/:memoId" : section === "financial-document" ? "/financial-documents/:documentId" : section === "item" ? "/items/:itemId" : section === "invoice" ? "/invoices/:invoiceId" : `/${section}`}`}
                  element={
                    <Protected>
                      <CompanyView
                        context={company.data}
                        loading={company.isFetching}
                        error={company.error}
                        section={section}
                      />
                    </Protected>
                  }
                />
              ))}
              <Route
                path="/companies/:companyId/overview"
                element={
                  <Navigate
                    to={
                      companyId > 0 ? `/companies/${companyId}` : "/companies"
                    }
                    replace
                  />
                }
              />
              <Route
                path="*"
                element={
                  <Card title="الصفحة غير موجودة">
                    <NavLink to="/" className="button button-secondary">
                      العودة إلى الرئيسية
                    </NavLink>
                  </Card>
                }
              />
            </Routes>
          </main>
          <footer className="workspace-footer">
            <span>تجارة</span>
            <span>الحسابات · الشركات · فريق العمل</span>
          </footer>
        </div>
      </div>
      <Dialog
        open={drawer}
        onClose={() => setDrawer(false)}
        title="قائمة التنقل"
      >
        <Navigation
          context={navigationContext}
          close={() => setDrawer(false)}
        />
      </Dialog>
    </AppearanceProvider>
  );
}
export function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}

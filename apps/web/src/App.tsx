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
  BookOpen,
  ChevronLeft,
  CircleUserRound,
  Coins,
  FileClock,
  FileText,
  HandCoins,
  Landmark,
  Wallet,
  Home,
  TableProperties,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MapPin,
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
import { AppearanceButton, AppearanceProvider } from "./theme";
import { Button, Card, Dialog, Notice } from "./ui";
import { moduleAccess } from "./phase2";
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

const GeneralTablePage = lazy(() =>
  import("./pages/GeneralTablePage").then((module) => ({
    default: module.GeneralTablePage,
  })),
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
const mayReadFinance = (context: CompanyContext) =>
  context.general ||
  context.permissions.some((permission) =>
    ["finance.view", "finance.manage", "finance.post"].includes(permission),
  );
const companySections = [
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
  const link = (
    to: string,
    title: string,
    icon: React.ReactNode,
    end = false,
  ) => (
    <NavLink
      to={to}
      end={end}
      onClick={close}
      className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
    >
      {icon}
      <span>{title}</span>
      <ChevronLeft size={13} className="nav-chevron" />
    </NavLink>
  );
  return (
    <nav aria-label="التنقل الرئيسي">
      <div className="nav-label">الموقع العام</div>
      {link("/", "الرئيسية", <Home size={17} />, true)}
      {user && (
        <>
          {link("/profile", "حسابي", <CircleUserRound size={17} />)}
          {link("/companies", "الشركات", <Building2 size={17} />, true)}
          {(user.owner || user.kind === "admin") &&
            link("/users", "المستخدمون", <Users size={17} />)}
          {(user.owner || user.kind === "admin") &&
            link(
              "/general-table",
              "الجدول العام",
              <TableProperties size={17} />,
            )}
          {(user.owner || user.kind === "admin" || user.monitor) &&
            link("/audit", "السجل العام", <FileClock size={17} />)}
        </>
      )}
      {!user && link("/login", "تسجيل الدخول", <LogIn size={17} />)}
      {context && (
        <>
          <div className="nav-label company-nav-label">
            {context.company.name}
          </div>
          {link(
            `/companies/${context.company.id}`,
            "نظرة عامة",
            <LayoutDashboard size={17} />,
            true,
          )}
          {(context.general ||
            context.permissions.includes("employees.view")) &&
            link(
              `/companies/${context.company.id}/employees`,
              "الموظفون",
              <Users size={17} />,
            )}
          {(context.general || context.permissions.includes("company.edit")) &&
            link(
              `/companies/${context.company.id}/settings`,
              "بيانات الشركة",
              <Settings2 size={17} />,
            )}
          {moduleAccess(context, "accounts") &&
            link(
              `/companies/${context.company.id}/accounts`,
              "دليل الحسابات",
              <BookOpen size={17} />,
            )}
          {mayReadFinance(context) && (
            <>
              {link(
                `/companies/${context.company.id}/financial-documents`,
                "العمليات المالية",
                <FileText size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/journals`,
                "قيود اليومية",
                <BookOpen size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/receipts`,
                "سندات القبض",
                <HandCoins size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/payments`,
                "سندات الصرف",
                <Wallet size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/account-balances`,
                "أرصدة الحسابات",
                <Landmark size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/account-ledger`,
                "كشف حساب",
                <FileText size={17} />,
              )}
            </>
          )}
          {moduleAccess(context, "currencies") && (
            <>
              {link(
                `/companies/${context.company.id}/currencies`,
                "العملات",
                <Coins size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/exchange-rates`,
                "أسعار الصرف",
                <TrendingUp size={17} />,
              )}
            </>
          )}
          {moduleAccess(context, "locations") && (
            <>
              {link(
                `/companies/${context.company.id}/branches`,
                "الفروع",
                <MapPin size={17} />,
              )}
              {link(
                `/companies/${context.company.id}/locations`,
                "المعارض والمخازن",
                <Warehouse size={17} />,
              )}
            </>
          )}
          {(context.general || context.permissions.includes("audit.view")) &&
            link(
              `/companies/${context.company.id}/audit`,
              "سجل الشركة",
              <FileClock size={17} />,
            )}
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
  switch (section) {
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
        <aside className="sidebar">
          <NavLink to="/" className="brand">
            <span className="brand-symbol">ت</span>
            <span>
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
              <AppearanceButton />
              {user ? (
                <>
                  <NavLink
                    to="/profile"
                    className="account-name"
                    title={user.displayName}
                  >
                    {user.displayName}
                  </NavLink>
                  <Button
                    variant="ghost"
                    aria-label="تسجيل الخروج"
                    onClick={() => {
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
                  >
                    <LogOut size={17} />
                  </Button>
                </>
              ) : (
                <NavLink
                  className="button button-secondary desktop-only"
                  to="/login"
                >
                  تسجيل الدخول
                </NavLink>
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
                    <UsersPage />
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
                      <GeneralTablePage />
                    </Suspense>
                  </Protected>
                }
              />
              <Route
                path="/audit"
                element={
                  <Protected>
                    <PublicAuditPage />
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
                  path={`/companies/:companyId${section === "overview" ? "" : section === "financial-document" ? "/financial-documents/:documentId" : `/${section}`}`}
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

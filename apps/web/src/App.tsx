import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  NavLink,
  Link,
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
  Scale,
  LayoutDashboard,
  ListTree,
  LogIn,
  Menu,
  MessageSquare,
  MonitorSmartphone,
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
import { useCompanyLogo, useCompanyLogoFavicon } from "./CompanyLogo";
import {stopEmployeePreview} from "./employee-preview-mode";
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
import { QuickMessageDeliveryStatus } from "./QuickMessageDelivery";
import { enqueueCompanyActivation } from "./last-company-activation";
import { NotificationBell } from "./NotificationBell";
import { AppSetup } from "./AppSetup";
import { InstallBanner } from "./InstallBanner";
import { AppUpdatePrompt } from "./AppUpdatePrompt";
import { PresenceHeartbeat } from "./PresenceHeartbeat";
import { CompanyDeviceDiscovery } from "./company-device-discovery";
import { QuickLoginPage } from "./QuickLoginPage";
import { LastPresentUsersPage } from "./pages/LastPresentUsersPage";
import { SystemMonitorPage } from "./pages/SystemMonitorPage";
import { AttendanceCurrentlyPresent } from "./AttendanceCurrentlyPresent";
import { ConnectionModeControl } from "./ConnectionModeControl";
import { WalletIndicator } from "./WalletIndicator";
import { CompanyPrintHeader } from "./CompanyPrintHeader";
import { ItemCardBottomSheetHost } from "./ItemCardBottomSheetHost";
import { ItemQuickInventorySheetHost } from "./ItemQuickInventorySheetHost";
import { reportPrintLayout } from "./reportPrintLayout";
import { CompanyLetterheadPage } from "./pages/CompanyLetterheadPage";
import { useCompanyIdleLogout } from "./idle-logout";
import { Button, Card, Dialog, Notice, PageHeader } from "./ui";
import {
  AuthPage,
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

const CentralAccessPage = lazy(() =>
  import("./pages/CentralAccessPage").then(m=>({default:m.CentralAccessPage})),
);
const MedicineMarketPage = lazy(() => import("./pages/MedicineMarketPage").then(m=>({default:m.MedicineMarketPage})));
const PageDirectoryPage = lazy(() =>
  import("./pages/PageDirectoryPage").then((module) => ({
    default: module.PageDirectoryPage,
  })),
);
const AccountStatisticsReportPage = lazy(() =>
  import("./pages/AccountStatisticsReportPage").then((module) => ({
    default: module.AccountStatisticsReportPage,
  })),
);
const LegacySalesImportPage = lazy(() => import("./pages/LegacySalesImportPage").then(m=>({default:m.LegacySalesImportPage})));
const LegalCasesPage = lazy(() => import("./pages/LegalCasesPage").then(module => ({default:module.LegalCasesPage})));
const ArchivePage = lazy(() => import("./pages/ArchivePage").then(module => ({default:module.ArchivePage})));
const ExplanationsPage = lazy(() => import("./pages/ExplanationsPage").then(module => ({default:module.ExplanationsPage})));
const ExplanationsAccessPage = lazy(() => import("./pages/ExplanationsAccessPage").then(module => ({default:module.ExplanationsAccessPage})));
const ExplanationsTopicIndex = lazy(() => import("./pages/ExplanationsReader").then(module=>({default:module.ExplanationsTopicIndex})));
const ExplanationsContinuousReader = lazy(() => import("./pages/ExplanationsReader").then(module=>({default:module.ExplanationsContinuousReader})));
const ExplanationsTopicReader = lazy(() => import("./pages/ExplanationsReader").then(module=>({default:module.ExplanationsTopicReader})));
const GeneralTablePage = lazy(() =>
  import("./pages/GeneralTablePage").then((module) => ({
    default: module.GeneralTablePage,
  })),
);
const ControlPage = lazy(() =>
  import("./pages/ControlPage").then((module) => ({
    default: module.ControlPage,
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
const ChatPage = lazy(() =>
  import("./pages/ChatPage").then((module) => ({ default: module.ChatPage })),
);
const NotificationTemplatesPage = lazy(() =>
  import("./pages/NotificationsPage").then((module) => ({
    default: module.NotificationTemplatesPage,
  })),
);
const AutomaticTasksPage = lazy(() =>
  import("./pages/AutomaticTasksPage").then((m)=>({default:m.AutomaticTasksPage})),
);
const MemosPage = lazy(() =>
  import("./pages/MemosPage").then((module) => ({ default: module.MemosPage })),
);
const MemoFeatureRulesPage = lazy(() =>
  import("./pages/MemoFeatureRulesPage").then(module=>({default:module.MemoFeatureRulesPage})),
);
const MemoReportPage = lazy(() =>
  import("./pages/MemoReportPage").then(module=>({default:module.MemoReportPage})),
);
const QuestionsPage = lazy(() =>
  import("./pages/QuestionsPage").then((module) => ({ default: module.QuestionsPage })),
);
const MemoDetailPage = lazy(() =>
  import("./pages/MemosPage").then((module) => ({ default: module.MemoDetailPage })),
);
const DoctorsPage = lazy(() => import("./pages/DoctorsPage").then(module => ({ default: module.DoctorsPage })));
const SaleCustomersPage = lazy(() => import("./pages/SaleCustomersPage").then(module => ({ default: module.SaleCustomersPage })));
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
const TrialBalancePage = lazy(() =>
  import("./pages/FinancialReportsPages").then((module) => ({ default: module.TrialBalancePage })),
);
const CashFlowsPage = lazy(() =>
  import("./pages/FinancialReportsPages").then((module) => ({ default: module.CashFlowsPage })),
);
const MyCashboxLedgerPage = lazy(() =>
  import("./pages/MyCashboxLedgerPage").then((module) => ({
    default: module.MyCashboxLedgerPage,
  })),
);
const AccountLedgerPage = lazy(() =>
  import("./pages/FinancePages").then((module) => ({
    default: module.AccountLedgerPage,
  })),
);
const ItemFormDifferencesPage = lazy(() =>
  import("./pages/ItemFormDifferencesPage").then(m=>({default:m.ItemFormDifferencesPage})),
);
const ItemStatisticsReportPage = lazy(() =>
  import("./pages/ItemStatisticsReportPage").then(m=>({default:m.ItemStatisticsReportPage})),
);
const SalesTimeReportPage = lazy(() =>
  import("./pages/SalesTimeReportPage").then(m => ({ default: m.SalesTimeReportPage })),
);
const DoctorSalesReportPage = lazy(() =>
  import("./pages/DoctorSalesReportPage").then(m=>({default:m.DoctorSalesReportPage})),
);
const DoctorSalesMovementsPage = lazy(() =>
  import("./pages/DoctorSalesMovementsPage").then(m => ({ default: m.DoctorSalesMovementsPage })),
);
const ItemOptionsListPage = lazy(() =>
  import("./pages/ItemOptionsListPage").then(m=>({default:m.ItemOptionsListPage})),
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
const SettlementFollowUpPage = lazy(() =>
  import("./pages/SettlementFollowUpPage").then((module) => ({
    default: module.SettlementFollowUpPage,
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
const ElectronicReceiptsPage = lazy(() =>
  import("./pages/PouchReceiptsPage").then(module=>({default:module.ElectronicReceiptsPage})),
);
const PouchReceiptsPage = lazy(() =>
  import("./pages/PouchReceiptsPage").then(module=>({default:module.PouchReceiptsPage})),
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
const CompanyApprovedDevicesPage = lazy(() => import("./pages/CompanyApprovedDevicesPage").then(m => ({ default: m.CompanyApprovedDevicesPage })));
const companySections = [
  "archive",
  "chat",
  "notifications",
  "notification-templates",
  "memos",
  "questions",
  "answers",
  "tasks",
  "memo-report",
  "memo-feature-rules",
  "memo-detail",
  "attendance",
  "attendance-current",
  "wallet",
  "reward-tasks",
  "wallet-settings",
  "wallet-conversions",
  "pages",
  "configuration",
  "control",
  "overview",
  "employees",
  "approved-devices",
  "settings",
  "letterhead",
  "audit",
  "accounts",
  "account-statistics",
  "doctors",
  "sale-customers",
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
  "trial-balance",
  "cash-flows",
  "account-ledger",
  "my-cashbox-ledger",
  "administrative-custody",
  "items",
  "item-statistics-report",
  "doctor-sales-report",
  "doctor-sales-movements",
  "sales-time-report",
  "item-options-list",
  "central-access",
  "item",
  "item-agents",
  "item-compositions",
  "item-form-differences",
  "item-shelves",
  "stock-balances",
  "stock-movements",
  "stock-operations",
  "stock-adjustments",
  "settlement-follow-up",
  "inventory-settings",
  "purchases",
  "legacy-sales-import",
  "sales",
  "pouch-receipts",
  "electronic-receipts",
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
  const { user, employeePreview } = useSession();
  const directory = usePageDirectory(context?.company.id);
  const entries =
    directory.data ??
    (employeePreview ? [] : pageDefinitions.map((definition) => ({
      ...definition,
      href: pageHref(definition, context?.company.id),
      enabled: true,
      actionAccess: {
        view: pageRuleAllows(definition.actions.view, user, context),
      },
    })));
  const icons: Record<string, React.ReactNode> = {
    "public.home": <Home size={17} />,
    "public.medicine-market": <Package size={17} />,
    "public.medicine-market-review": <ShieldCheck size={17} />,
    "public.medicine-market-contributions": <ListChecks size={17} />,
    "public.medicine-market-points": <Coins size={17} />,
    "public.profile": <CircleUserRound size={17} />,
    "public.companies": <Building2 size={17} />,
    "public.users": <Users size={17} />,
    "public.system-monitor": <LayoutDashboard size={17} />,
    "public.last-present": <FileClock size={17} />,
    "public.general-table": <TableProperties size={17} />,
    "public.explanations-reader": <BookOpen size={17}/>,
    "public.explanations-editor": <FileText size={17}/>,
    "public.explanations-access": <ShieldCheck size={17}/>,
    "public.legal-cases": <Scale size={17} />,
    "public.archive": <FileText size={17} />,
    "company.archive": <FileText size={17} />,
    "public.audit": <FileClock size={17} />,
    "public.notifications": <Bell size={17} />,
    "public.tasks": <FileClock size={17} />,
    "company.tasks": <FileClock size={17} />,
    "public.chat": <MessageSquare size={17} />,
    "public.notification-templates": <Settings2 size={17} />,
    "company.overview": <LayoutDashboard size={17} />,
    "company.configuration": <ShieldCheck size={17} />,
    "company.control": <Settings2 size={17} />,
    "company.employees": <Users size={17} />,
    "company.approved-devices": <MonitorSmartphone size={17} />,
    "company.attendance": <FileClock size={17} />,
    "company.attendance-current": <Users size={17} />,
    "company.wallet": <Wallet size={17} />,
    "company.reward-tasks": <Coins size={17} />,
    "company.wallet-settings": <Wallet size={17} />,
    "company.wallet-conversions": <Wallet size={17} />,
    "company.notifications": <Bell size={17} />,
    "company.chat": <MessageSquare size={17} />,
    "company.notification-templates": <Settings2 size={17} />,
    "company.memos": <FileText size={17} />,
    "company.questions": <ListChecks size={17} />,
    "company.answers": <ListChecks size={17} />,
    "public.questions": <ListChecks size={17} />,
    "public.answers": <ListChecks size={17} />,
    "company.settings": <Settings2 size={17} />,
    "company.letterhead": <FileText size={17} />,
    "company.accounts": <BookOpen size={17} />,
    "company.account-statistics": <TrendingUp size={17} />,
    "company.doctors": <Users size={17} />,
    "company.sale-customers": <Users size={17} />,
    "company.items": <Package size={17} />,
    "company.central-access": <Settings2 size={17} />,
    "company.item-statistics-report": <TrendingUp size={17} />,
    "company.item-options-list": <ListTree size={17} />,
    "company.item-agents": <Users size={17} />,
    "company.item-compositions": <Package size={17} />,
    "company.item-form-differences": <FileText size={17} />,
    "company.item-shelves": <Package size={17} />,
    "company.stock-balances": <Warehouse size={17} />,
    "company.stock-movements": <FileText size={17} />,
    "company.stock-operations": <Package size={17} />,
    "company.stock-adjustments": <Package size={17} />,
    "company.settlement-follow-up": <TableProperties size={17} />,
    "company.inventory-settings": <Settings2 size={17} />,
    "company.sales": <FileText size={17} />,
    "company.sales-time-report": <TrendingUp size={17} />,
    "company.doctor-sales-movements": <FileText size={17} />,
    "company.pouch-receipts": <HandCoins size={17} />,
    "company.electronic-receipts": <Wallet size={17} />,
    "company.purchases": <FileText size={17} />,
    "company.financial-documents": <FileText size={17} />,
    "company.journals": <BookOpen size={17} />,
    "company.receipts": <HandCoins size={17} />,
    "company.payments": <Wallet size={17} />,
    "company.account-balances": <Landmark size={17} />,
    "company.trial-balance": <Scale size={17} />,
    "company.cash-flows": <TrendingUp size={17} />,
    "company.account-ledger": <FileText size={17} />,
    "company.my-cashbox-ledger": <Landmark size={17} />,
    "company.administrative-custody": <Landmark size={17} />,
    "company.currencies": <Coins size={17} />,
    "company.exchange-rates": <TrendingUp size={17} />,
    "company.branches": <MapPin size={17} />,
    "company.locations": <Warehouse size={17} />,
    "company.audit": <FileClock size={17} />,
  };
  const links = (scope: "public" | "company") =>
    [...(employeePreview ? entries.filter(e=>e.scope==="company") : entries)]
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      .filter(
        (entry) =>
          entry.scope === scope &&
          (user?.owner || user?.kind === "admin" ||
            !["public.users", "public.chat"].includes(entry.key)) &&
          entry.navigation &&
          entry.href &&
          entry.visible &&
          entry.enabled &&
          entry.actionAccess.view,
      )
      .map((entry) => (
        <NavLink
          key={entry.key}
          to={entry.key === "public.home" ? "/medicine-market" : entry.href!}
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
      <div className="nav-label nav-heading">السوق الرئيسي</div>
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
          <NavLink
            to={`/companies/${context.company.id}`}
            onClick={close}
            className="nav-label nav-heading company-nav-label company-nav-link"
            title="فتح صفحة الشركة"
          >
            {context.company.name}
          </NavLink>
          {links("company")}
          {user?.owner && <NavLink to={`/companies/${context.company.id}/legacy-sales-import`} onClick={close} className="nav-link"><FileText size={17}/><span className="nav-text">ترحيل مبيعات النظام السابق</span></NavLink>}
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
  const queryClient = useQueryClient();
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
      {reportPrintLayout(pageKey) === "generic" ? (
        <div className="company-report-printable">
          <CompanyPrintHeader context={context} />
          {pageKey !== "company.my-cashbox-ledger" && (
            <div className="company-report-print-toolbar">
              <Button variant="secondary" onClick={() => window.print()}>
                طباعة التقرير
              </Button>
              {pageKey === "company.doctor-sales-movements" && (
                <Button variant="secondary" onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["doctor-sales-movements", user?.id, context.company.id],
                  })
                }>
                  تحديث
                </Button>
              )}
            </div>
          )}
          <CompanyContent context={context} section={section} />
        </div>
      ) : (
        <CompanyContent context={context} section={section} />
      )}
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
  const { user } = useSession();
  switch (section) {
    case "questions":
    case "answers":
      return <Suspense fallback={<Notice>جارٍ تحميل الأسئلة…</Notice>}>
        <QuestionsPage key={context.company.id} companyId={context.company.id} tab={section} />
      </Suspense>;
    case "archive":
      return <Suspense fallback={<Notice>جارٍ تحميل الأرشيف…</Notice>}><ArchivePage companyId={context.company.id}/></Suspense>;
    case "chat":
      return user ? (
        <Suspense fallback={<Notice>جارٍ تحميل الدردشة…</Notice>}>
          <ChatPage key={`${user.id}:company:${context.company.id}`} scope="company" companyId={context.company.id} user={user} />
        </Suspense>
      ) : null;
    case "tasks":
      return <Suspense fallback={<Notice>جارٍ تحميل المهام…</Notice>}><AutomaticTasksPage key={context.company.id} context={context}/></Suspense>;
    case "memos":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل المذكرات…</Notice>}>
          <MemosPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "memo-report":
      return <Suspense fallback={<Notice>جارٍ تحميل تقرير المذكرات…</Notice>}>
        <MemoReportPage key={context.company.id} context={context}/>
      </Suspense>;
    case "memo-feature-rules":
      return <Suspense fallback={<Notice>جارٍ تحميل قواعد الميزات…</Notice>}>
        <MemoFeatureRulesPage key={context.company.id} context={context}/>
      </Suspense>;
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
    case "attendance-current":
      return (
        <>
          <PageHeader title="المحضرون حاليًا"
            description="آخر حضور وانصراف وآخر نشاط في النظام لكل موظف؛ المدة بالأيام والساعات والدقائق وفوق التاريخ التفصيلي. المحضرون بالأخضر أولًا." />
          <Card>
            <AttendanceCurrentlyPresent companyId={context.company.id} />
          </Card>
        </>
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
    case "control":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل الكنترول…</Notice>}>
          <ControlPage key={context.company.id} context={context} />
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
    case "approved-devices":
      return <Suspense fallback={<Notice>جارٍ تحميل الأجهزة المعتمدة…</Notice>}><CompanyApprovedDevicesPage context={context} /></Suspense>;
    case "settings":
      return <CompanySettingsPage key={context.company.id} context={context} />;
    case "letterhead":
      return <CompanyLetterheadPage key={context.company.id} context={context} />;
    case "audit":
      return <CompanyAuditPage key={context.company.id} context={context} />;
    case "doctors":
      return <Suspense fallback={<Notice>جارٍ تحميل الأطباء والجهات…</Notice>}>
        <DoctorsPage key={context.company.id} context={context} />
      </Suspense>;
    case "sale-customers":
      return <Suspense fallback={<Notice>جارٍ تحميل كروت العملاء…</Notice>}>
        <SaleCustomersPage key={context.company.id} context={context} />
      </Suspense>;
    case "accounts":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل دليل الحسابات…</Notice>}>
          <AccountsPage key={context.company.id} context={context} />
        </Suspense>
      );
    case "account-statistics":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل إحصاءات الحسابات…</Notice>}>
          <AccountStatisticsReportPage
            key={context.company.id}
            context={context}
          />
        </Suspense>
      );
    case "item-statistics-report":
      return <Suspense fallback={<Notice>جارٍ تحميل تقرير إحصائيات الأصناف…</Notice>}>
        <ItemStatisticsReportPage key={context.company.id} context={context}/>
      </Suspense>;
    case "sales-time-report":
      return <Suspense fallback={<Notice>جارٍ تحميل تقرير المبيعات حسب الأوقات…</Notice>}>
        <SalesTimeReportPage key={context.company.id} context={context}/>
      </Suspense>;
    case "doctor-sales-report":
      return <Suspense fallback={<Notice>جارٍ تحميل مبيعات الأطباء والجهات…</Notice>}>
        <DoctorSalesReportPage key={context.company.id} context={context}/>
      </Suspense>;
    case "doctor-sales-movements":
      return <Suspense fallback={<Notice>جارٍ تحميل حركة مبيعات الأطباء والممرضين…</Notice>}>
        <DoctorSalesMovementsPage key={context.company.id} context={context}/>
      </Suspense>;
    case "item-options-list":
      return <Suspense fallback={<Notice>جارٍ تحميل قائمة الأصناف…</Notice>}>
        <ItemOptionsListPage key={context.company.id} context={context}/>
      </Suspense>;
    case "central-access":
      return <Suspense fallback={<Notice>جارٍ تحميل مركز الصلاحيات…</Notice>}>
        <CentralAccessPage key={context.company.id} context={context}/>
      </Suspense>;
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
    case "item-form-differences":
      return <Suspense fallback={<Notice>جارٍ تحميل تقرير مقارنة أشكال الأصناف…</Notice>}>
        <ItemFormDifferencesPage key={context.company.id} context={context}/>
      </Suspense>;
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
    case "settlement-follow-up":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل متابعة التسويات للأصناف…</Notice>}>
          <SettlementFollowUpPage key={context.company.id} context={context} />
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
    case "electronic-receipts":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل استلام المحفظة الإلكترونية…</Notice>}>
          <ElectronicReceiptsPage key={context.company.id} context={context}/>
        </Suspense>
      );
    case "pouch-receipts":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل حركات الحوافظ…</Notice>}>
          <PouchReceiptsPage key={context.company.id} context={context}/>
        </Suspense>
      );
    case "legacy-sales-import":
      return user?.owner ? <Suspense fallback={<Notice>جارٍ تحميل الاستيراد…</Notice>}><LegacySalesImportPage context={context}/></Suspense> : <Notice tone="error">للمالك فقط</Notice>;
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
    case "trial-balance":
      return user?.owner ? <Suspense fallback={<Notice>جارٍ تحميل ميزان المراجعة…</Notice>}>
        <TrialBalancePage key={context.company.id} context={context} />
      </Suspense> : <Notice tone="error">هذه الصفحة للمالك فقط.</Notice>;
    case "cash-flows":
      return user?.owner ? <Suspense fallback={<Notice>جارٍ تحميل التدفقات المالية…</Notice>}>
        <CashFlowsPage key={context.company.id} context={context} />
      </Suspense> : <Notice tone="error">هذه الصفحة للمالك فقط.</Notice>;
    case "administrative-custody":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل العهدة الإدارية…</Notice>}>
          <MyCashboxLedgerPage key={context.company.id} context={context}
            mode="administrativeCustody" />
        </Suspense>
      );
    case "my-cashbox-ledger":
      return (
        <Suspense fallback={<Notice>جارٍ تحميل كشف حساب صندوقي…</Notice>}>
          <MyCashboxLedgerPage key={context.company.id} context={context} />
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
    employeePreview,
    loading: sessionLoading,
    error: sessionError,
    logout,
    pendingLogoutRedirect,
    visitorOnly,
    acknowledgeLogoutRedirect,
    requiresOnlineLogin,
  } = useSession();
  const match = useMatch("/companies/:companyId/*");
  const companyId = Number(match?.params.companyId);
  const inCompany = Number.isSafeInteger(companyId) && companyId > 0;
  const scope = inCompany ? `company:${companyId}` : "public";
  const companyLogo = useCompanyLogo(inCompany ? companyId : null);
  useCompanyLogoFavicon(inCompany ? companyLogo.data?.iconUrl : null);
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [endingPreview,setEndingPreview]=useState(false);
  const [logoutError, setLogoutError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const main = useRef<HTMLElement>(null);
  // Activations must finish even when navigating away from a company quickly.
  // Queue them in visit order, so a slower earlier request cannot replace the
  // last company the user actually opened.
  const activationQueue = useRef<Promise<void>>(Promise.resolve());
  const priorPath = useRef(location.pathname);
  const publicPageVisit = useRef<string | null>(null);
  async function exitEmployeePreview(){
    if(!employeePreview||endingPreview)return;
    setEndingPreview(true);
    try{
      await queryClient.cancelQueries();
      queryClient.clear();
      const returnCompanyId=employeePreview.companyId;
      stopEmployeePreview();
      navigate(`/companies/${returnCompanyId}/central-access`,{replace:true});
    }finally{setEndingPreview(false);}
  }
  // The selected employee preview is intentionally restricted to one company.
  // Never silently show owner's public pages as an employee.
  useEffect(()=>{
    if(!employeePreview)return;
    if(!location.pathname.startsWith(`/companies/${employeePreview.companyId}/`) &&
       location.pathname!==`/companies/${employeePreview.companyId}`)
      navigate(`/companies/${employeePreview.companyId}`,{replace:true});
  },[employeePreview,location.pathname,navigate]);
  useEffect(() => {
    // Company routes and other public pages are tracked by PageRouteGuard.
    // These few public routes are rendered without that guard.
    if (!user || inCompany || !["/", "/companies", "/profile", "/pages"].includes(location.pathname))
      return;
    const pageKey = pageKeyForLocation(location.pathname, location.search);
    if (!pageKey?.startsWith("public.")) return;
    const visit = `${user.id}:${pageKey}:${location.pathname}`;
    if (publicPageVisit.current === visit) return;
    publicPageVisit.current = visit;
    void api("/page-catalog/visit", {
      method: "POST", body: { pageKey },
    }).catch(() => {});
  }, [user?.id, inCompany, location.pathname, location.search]);
  const company = useQuery({
    queryKey: ["company", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<CompanyContext>(`/companies/${companyId}`, { signal }),
    enabled: !!user && inCompany,
    // The company/employee context was saved after an authorized online GET.
    // Permit the user-scoped savedRead fallback to execute without internet.
    networkMode: "always",
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
    enabled: !!user && !inCompany && !visitorOnly,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  // In the public market, show the currently accessible company next to
  // the Alraesy application identity without opening the company's workspace.
  const marketCompanyLogo = useCompanyLogo(!inCompany && lastCompany.data && !lastCompany.isError
    ? lastCompany.data.company.id : null);
  const navigationContext = inCompany
    ? company.isError
      ? undefined
      : company.data
    : lastCompany.isError
      ? undefined
      : (lastCompany.data ?? undefined);
  useCompanyIdleLogout(companyId, navigationContext?.employee?.id ?? null, inCompany && !!navigationContext);
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
    if (!user || employeePreview || !inCompany || !company.data || company.isError) return;
    const userId = user.id;
    const selectedContext = company.data;
    // Do not abort this mutation in the cleanup: moving straight back to the
    // public site previously cancelled the persisted last-company update.
    // Serializing visits also prevents a delayed earlier activation winning.
    void enqueueCompanyActivation(activationQueue, async () => {
      await api(`/companies/${companyId}/activate`, { method: "POST" });
      queryClient.setQueryData(["last-company-sidebar", userId], selectedContext);
      void queryClient.invalidateQueries({
        queryKey: ["wallet-summary", userId, companyId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["list", userId, `company:${companyId}:wallet`],
      });
    }).catch(() => {});
  }, [companyId, user?.id, !!company.data, company.isError, queryClient, employeePreview]);
  if (sessionLoading)
    return (
      <div className="boot-state">
        <img className="brand-symbol" src="/site-icon.png" alt="أيقونة الرئيسي" />
        <p>جارٍ تحميل الموقع…</p>
      </div>
    );
  // Render the public medicine market on both / and /medicine-market without
  // changing the visitor's address. The last accessible company still wins at /.
  const marketLanding = (
    <PageRouteGuard pageKey="public.medicine-market">
      <Suspense fallback={<Notice>جارٍ تحميل السوق الرئيسي…</Notice>}>
        <MedicineMarketPage key={user?.id ?? "guest"} />
      </Suspense>
    </PageRouteGuard>
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
            to="/medicine-market"
            className="brand"
            aria-label="الرئيسي — السوق الرئيسي"
            title="الرئيسي — السوق الرئيسي"
          >
            <img className="brand-symbol" src="/site-icon.png" alt="" />
            <span className="brand-copy">
              الرئيسي<small>Alraesy</small>
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
          <header className={inCompany && companyLogo.data?.iconUrl || !inCompany && !!marketCompanyLogo.data?.iconUrl ? "topbar topbar-company-logo" : "topbar"}>
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
              {inCompany && company.data && !company.isError ? (
                <Link
                  className="scope-title scope-title-link"
                  to={`/companies/${companyId}`}
                  aria-label={`فتح صفحة ${company.data.company.name}`}
                  title="فتح صفحة الشركة"
                >
                  <span className={companyLogo.data?.iconUrl ? "scope-mark scope-mark-logo" : "scope-mark"}>
                    {companyLogo.data?.iconUrl?
                      <img src={companyLogo.data.iconUrl} alt="" className="company-scope-logo"/>:
                      <Building2 size={16} />}
                  </span>
                  <div>
                    <strong>{company.data.company.name}</strong>
                  </div>
                </Link>
              ) : (
                <div className="public-scope-titles">
                  <Link className="scope-title scope-title-link public-market-title"
                    to="/medicine-market" title="فتح السوق الرئيسي" aria-label="السوق الرئيسي">
                    <span className="scope-mark scope-mark-site">
                      <img src="/site-icon.png" className="public-site-logo" alt="" />
                    </span>
                    <div><strong>السوق الرئيسي</strong></div>
                  </Link>
                  {navigationContext && !employeePreview && (
                    <Link className="scope-title scope-title-link public-company-title"
                      to={`/companies/${navigationContext.company.id}`}
                      title={`فتح ${navigationContext.company.name}`}
                      aria-label={`فتح شركة ${navigationContext.company.name}`}>
                      <span className={marketCompanyLogo.data?.iconUrl
                        ? "scope-mark scope-mark-logo" : "scope-mark"}>
                        {marketCompanyLogo.data?.iconUrl ?
                          <img src={marketCompanyLogo.data.iconUrl}
                            className="company-scope-logo" alt="" /> :
                          <Building2 size={16} />}
                      </span>
                      <div><strong>{navigationContext.company.name}</strong></div>
                    </Link>
                  )}
                </div>
              )}
            </div>
            <div className="topbar-actions">
              {user && <ConnectionModeControl />}
              {user && inCompany && company.data && !company.isError && (
                <WalletIndicator
                  key={`${user.id}:${scope}`}
                  context={company.data}
                />
              )}
              {user && !employeePreview && !visitorOnly && (
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
                  // The last visited, still-accessible company is already resolved
                  // for public routes. Use it for personal shortcuts too.
                  companyId={navigationContext?.company.id ?? null}
                  employeeId={navigationContext?.employee?.id ?? null}
                  employeeName={navigationContext?.employee?.name ?? null}
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
          {employeePreview&&<div className="employee-preview-banner" role="status">
            <div>
              <strong>تصفح بصلاحيات: {employeePreview.employeeName}</strong>
              <span>معاينة للقراءة فقط — لا حفظ ولا تعديل ولا ترحيل ولا حذف</span>
            </div>
            <Button variant="secondary" disabled={endingPreview}
              onClick={()=>void exitEmployeePreview()}>
              {endingPreview?"جارٍ العودة…":"العودة إلى صلاحيات المالك"}
            </Button>
          </div>}
          <InstallBanner />
          {user && !employeePreview && inCompany && company.data && !company.isError && (
            <CompanyDeviceDiscovery userId={user.id} companyId={companyId} />
          )}
          <main className="main-content" ref={main} tabIndex={-1}>
            {sessionError && <Notice tone="error">{sessionError}</Notice>}
            {logoutError && <Notice tone="error">{logoutError}</Notice>}
            {requiresOnlineLogin && (
              <Notice tone="warning">هذا الموظف دخل دون إنترنت. عند توفر الاتصال، <Link to="/login">سجّل دخوله مجددًا</Link> لإرسال عملياته المحفوظة باسمه؛ لن تُستخدم جلسة الموظف السابق.</Notice>
            )}
            <Routes>
              <Route path="/" element={
                user
                  ? visitorOnly
                    ? marketLanding
                    : lastCompany.isPending
                    ? <Notice>جارٍ فتح شركتك…</Notice>
                    : lastCompany.data && !lastCompany.isError
                      ? <Navigate to={`/companies/${lastCompany.data.company.id}`} replace />
                      : marketLanding
                  : marketLanding
              } />
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/quick-login" element={<QuickLoginPage />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              <Route path="/medicine-market" element={marketLanding} />
              <Route path="/medicine-market/review" element={<Protected><PageRouteGuard pageKey="public.medicine-market-review"><Suspense fallback={<Notice>جارٍ تحميل المصادقات…</Notice>}><MedicineMarketPage key={`${user?.id}:review`} tab="review" /></Suspense></PageRouteGuard></Protected>} />
              <Route path="/medicine-market/contributions" element={<Protected><PageRouteGuard pageKey="public.medicine-market-contributions"><Suspense fallback={<Notice>جارٍ تحميل المساهمات…</Notice>}><MedicineMarketPage key={`${user?.id}:contributions`} tab="contributions" /></Suspense></PageRouteGuard></Protected>} />
              <Route path="/medicine-market/points" element={<Protected><PageRouteGuard pageKey="public.medicine-market-points"><Suspense fallback={<Notice>جارٍ تحميل إعدادات النقاط…</Notice>}><MedicineMarketPage key={`${user?.id}:points`} tab="points" /></Suspense></PageRouteGuard></Protected>} />
              <Route path="/tasks" element={<Protected><PageRouteGuard pageKey="public.tasks"><Suspense fallback={<Notice>جارٍ تحميل المهام…</Notice>}><AutomaticTasksPage /></Suspense></PageRouteGuard></Protected>} />
              <Route
                path="/chat"
                element={
                  <Protected>
                    <PageRouteGuard pageKey="public.chat">
                      <Suspense fallback={<Notice>جارٍ تحميل الدردشة…</Notice>}>
                        {user && <ChatPage key={`${user.id}:global`} scope="global" user={user} />}
                      </Suspense>
                    </PageRouteGuard>
                  </Protected>
                }
              />
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
              <Route path="/users/last-present" element={<Protected><PageRouteGuard pageKey="public.last-present"><LastPresentUsersPage /></PageRouteGuard></Protected>} />
              <Route path="/system-monitor" element={<Protected><PageRouteGuard pageKey="public.system-monitor"><SystemMonitorPage /></PageRouteGuard></Protected>} />
              <Route path="/explanations/topics" element={<Protected><PageRouteGuard pageKey="public.explanations-reader"><Suspense fallback={<Notice>جارٍ تحميل الشروح…</Notice>}><ExplanationsContinuousReader/></Suspense></PageRouteGuard></Protected>} />
              <Route path="/explanations/topic/:topicId" element={<Protected><PageRouteGuard pageKey="public.explanations-reader"><Suspense fallback={<Notice>جارٍ تحميل صفحة الشرح…</Notice>}><ExplanationsTopicReader/></Suspense></PageRouteGuard></Protected>} />
              <Route path="/explanations" element={<Protected><PageRouteGuard pageKey="public.explanations-editor"><Suspense fallback={<Notice>جارٍ تحميل إدارة الشروح…</Notice>}><ExplanationsPage/></Suspense></PageRouteGuard></Protected>} />
              <Route path="/explanations/access" element={<Protected><PageRouteGuard pageKey="public.explanations-access"><Suspense fallback={<Notice>جارٍ تحميل منح الصلاحيات…</Notice>}><ExplanationsAccessPage/></Suspense></PageRouteGuard></Protected>} />
              <Route path="/archive" element={<Protected><PageRouteGuard pageKey="public.archive"><Suspense fallback={<Notice>جارٍ تحميل أرشيف المستندات…</Notice>}><ArchivePage/></Suspense></PageRouteGuard></Protected>} />
              <Route path="/legal-cases" element={<Protected><Suspense fallback={<Notice>جارٍ تحميل نظام القضايا…</Notice>}><PageRouteGuard pageKey="public.legal-cases"><LegalCasesPage /></PageRouteGuard></Suspense></Protected>} />
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

            <ItemCardBottomSheetHost context={navigationContext} />
            <ItemQuickInventorySheetHost context={navigationContext} />
            {/* Device sync runs in the background, and notification setup remains below content.
                The installation call-to-action is displayed above the page instead. */}
            <AppSetup key={user?.id ?? "guest"} userId={visitorOnly ? undefined : user?.id}
              companyId={navigationContext?.company.id} />
          </main>
          <footer className="workspace-footer">
            <span>الرئيسي</span>
            <span>الحسابات · الشركات · فريق العمل</span>
          </footer>
        </div>
      </div>
      <PresenceHeartbeat userId={user?.id ?? null} />
      <QuickMessageDeliveryStatus userId={user?.id ?? null} />
      <AppUpdatePrompt />
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

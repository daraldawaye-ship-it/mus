import { Router } from "express";
import type { Pool } from "pg";
import { publicRoutes } from "./routes-public.ts";
import { companyRoutes } from "./routes-companies.ts";
import { walletRoutes } from "./routes-wallet.ts";
import { notificationRoutes } from "./routes-notifications.ts";
import { memoFeatureRuleRoutes } from "./memoFeatureRuleRoutes.ts";
import { memoRoutes } from "./routes-memos.ts";
import { questionRoutes } from "./routes-questions.ts";
import { medicineMarketRoutes } from "./routes-medicine-market.ts";
import { taskRoutes } from "./routes-tasks.ts";
import { attendanceRoutes } from "./routes-attendance.ts";
import { attendanceAdjustmentRoutes } from "./routes-attendance-adjustments.ts";
import { employeeAttendanceRoutes } from "./routes-employee-attendance.ts";
import { accountRoutes } from "./routes-accounts.ts";
import { accountStatisticsRoutes } from "./routes-account-statistics.ts";
import { currencyRoutes } from "./routes-currencies.ts";
import { locationRoutes } from "./routes-locations.ts";
import { generalTableRoutes } from "./routes-general-table.ts";
import { legalCaseRoutes } from "./routes-legal-cases.ts";
import { archiveRoutes } from "./routes-archive.ts";
import { explanationRoutes } from "./routes-explanations.ts";
import { financeRoutes } from "./routes-finance.ts";
import { itemRoutes } from "./routes-items.ts";
import { settlementFollowUpRoutes } from "./routes-settlement-follow-up.ts";
import { itemActivityReportRoutes } from "./routes-item-activity-report.ts";
import { itemOptionsListRoutes } from "./routes-item-options-list.ts";
import { itemTemporarySelectionRoutes } from "./routes-item-temporary-selection.ts";
import { itemImportRoutes } from "./routes-item-import.ts";
import { inventoryRoutes } from "./routes-inventory.ts";
import { openingInventoryRoutes } from "./routes-opening-inventory.ts";
import { commerceOptionRoutes } from "./routes-commerce-options.ts";
import { pageRoutes, pageAvailabilityGate } from "./routes-pages.ts";
import { shortcutRoutes } from "./routes-shortcuts.ts";
import { commerceRoutes } from "./routes-commerce.ts";
import { stagedInvoiceReadRoutes } from "./routes-staged-invoice-read.ts";
import { doctorRoutes } from "./routes-doctors.ts";
import { saleCustomerRoutes } from "./routes-sale-customers.ts";
import { configurationRoutes } from "./routes-configuration.ts";
import { controlRoutes } from "./routes-control.ts";
import { centralAccessRoutes } from "./routes-central-access.ts";
import { configurationAdministrationRoutes } from "./routes-configuration-admin.ts";
import { transactionResetRoutes } from "./routes-transaction-reset.ts";
import { transactionImportRoutes } from "./routes-transaction-import.ts";
import { qzipRemainingRoutes } from "./routes-qzip-remaining.ts";
import { legacySales127RepairRoutes } from "./routes-legacy-sales-127-repair.ts";
import { legacyImportRunRoutes } from "./routes-legacy-import-runs.ts";
import { importSourceDateRoutes } from "./routes-import-source-dates.ts";

/** Shared by browser and OAuth MCP: one set of domain policies and transactions. */
export function businessRoutes(pool: Pool): Router {
  const router = Router();
  router.use(
    pageRoutes(pool),
    shortcutRoutes(pool),
    transactionResetRoutes(pool),
    transactionImportRoutes(pool),
    qzipRemainingRoutes(pool),
    legacySales127RepairRoutes(pool),
    legacyImportRunRoutes(pool),
    importSourceDateRoutes(pool),
    pageAvailabilityGate(pool),
    publicRoutes(pool),
    companyRoutes(pool),
    attendanceRoutes(pool),
    attendanceAdjustmentRoutes(pool),
    employeeAttendanceRoutes(pool),
    notificationRoutes(pool),
    memoRoutes(pool),
    questionRoutes(pool),
    medicineMarketRoutes(pool),
    taskRoutes(pool),
    memoFeatureRuleRoutes(pool),
    walletRoutes(pool),
    configurationRoutes(pool),
    controlRoutes(pool),
    centralAccessRoutes(pool),
    configurationAdministrationRoutes(pool),
    accountRoutes(pool),
    accountStatisticsRoutes(pool),
    currencyRoutes(pool),
    locationRoutes(pool),
    generalTableRoutes(pool),
    legalCaseRoutes(pool),
    archiveRoutes(pool),
    explanationRoutes(pool),
    financeRoutes(pool),
    itemRoutes(pool),
    settlementFollowUpRoutes(pool),
    itemActivityReportRoutes(pool),
    itemOptionsListRoutes(pool),
    itemTemporarySelectionRoutes(pool),
    itemImportRoutes(pool),
    inventoryRoutes(pool),
    openingInventoryRoutes(pool),
    commerceOptionRoutes(pool),
    doctorRoutes(pool),
    saleCustomerRoutes(pool),
    commerceRoutes(pool),
    stagedInvoiceReadRoutes(pool),
  );
  return router;
}

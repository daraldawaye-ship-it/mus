import { Router } from "express";
import type { Pool } from "pg";
import { publicRoutes } from "./routes-public.ts";
import { companyRoutes } from "./routes-companies.ts";
import { walletRoutes } from "./routes-wallet.ts";
import { notificationRoutes } from "./routes-notifications.ts";
import { memoFeatureRuleRoutes } from "./memoFeatureRuleRoutes.ts";
import { memoRoutes } from "./routes-memos.ts";
import { attendanceRoutes } from "./routes-attendance.ts";
import { attendanceAdjustmentRoutes } from "./routes-attendance-adjustments.ts";
import { employeeAttendanceRoutes } from "./routes-employee-attendance.ts";
import { accountRoutes } from "./routes-accounts.ts";
import { currencyRoutes } from "./routes-currencies.ts";
import { locationRoutes } from "./routes-locations.ts";
import { generalTableRoutes } from "./routes-general-table.ts";
import { financeRoutes } from "./routes-finance.ts";
import { itemRoutes } from "./routes-items.ts";
import { itemActivityReportRoutes } from "./routes-item-activity-report.ts";
import { itemImportRoutes } from "./routes-item-import.ts";
import { inventoryRoutes } from "./routes-inventory.ts";
import { commerceOptionRoutes } from "./routes-commerce-options.ts";
import { pageRoutes, pageAvailabilityGate } from "./routes-pages.ts";
import { shortcutRoutes } from "./routes-shortcuts.ts";
import { commerceRoutes } from "./routes-commerce.ts";
import { doctorRoutes } from "./routes-doctors.ts";
import { configurationRoutes } from "./routes-configuration.ts";
import { controlRoutes } from "./routes-control.ts";
import { configurationAdministrationRoutes } from "./routes-configuration-admin.ts";
import { transactionResetRoutes } from "./routes-transaction-reset.ts";
import { transactionImportRoutes } from "./routes-transaction-import.ts";

/** Shared by browser and OAuth MCP: one set of domain policies and transactions. */
export function businessRoutes(pool: Pool): Router {
  const router = Router();
  router.use(
    pageRoutes(pool),
    shortcutRoutes(pool),
    transactionResetRoutes(pool),
    transactionImportRoutes(pool),
    pageAvailabilityGate(pool),
    publicRoutes(pool),
    companyRoutes(pool),
    attendanceRoutes(pool),
    attendanceAdjustmentRoutes(pool),
    employeeAttendanceRoutes(pool),
    notificationRoutes(pool),
    memoRoutes(pool),
    memoFeatureRuleRoutes(pool),
    walletRoutes(pool),
    configurationRoutes(pool),
    controlRoutes(pool),
    configurationAdministrationRoutes(pool),
    accountRoutes(pool),
    currencyRoutes(pool),
    locationRoutes(pool),
    generalTableRoutes(pool),
    financeRoutes(pool),
    itemRoutes(pool),
    itemActivityReportRoutes(pool),
    itemImportRoutes(pool),
    inventoryRoutes(pool),
    commerceOptionRoutes(pool),
    doctorRoutes(pool),
    commerceRoutes(pool),
  );
  return router;
}

import type { Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  pageActions,
  pageByKey,
  pageDefinitions,
  pageHref,
  pageRuleAllows,
  type PageAction,
  type PageEntry,
  type PageReference,
  type ResolvedPage,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import type { Database } from "../db.ts";
import { companyAccess } from "../policies/access.ts";
import { HttpError, missing } from "../errors.ts";
import {
  permissionRuleEffects,
  pagePermissionAliases,
  requirementForAction,
} from "./permission-rules.ts";

import { memoFollowerSql } from "./memo-followers.ts";
export async function directoryEntries(
  db: Database,
  user: User,
  companyId: number | null,
): Promise<PageEntry[]> {
  const context = companyId ? await companyAccess(db, user, companyId) : null;
  const effects =
    context?.employee && !context.general
      ? await permissionRuleEffects(db, companyId!, context.employee.id)
      : new Map<string, "allow" | "deny">();
  const baseContext =
    context && !context.general
      ? { ...context, permissions: [...(context.employee?.permissions ?? [])] }
      : context;
  if (baseContext && !baseContext.general) {
    for (const module of [
      "accounts",
      "currencies",
      "locations",
      "items",
      "commerce",
      "inventory",
    ] as const) {
      if (
        baseContext.permissions.includes(`${module}.manage`) &&
        !baseContext.permissions.includes(`${module}.view`)
      )
        baseContext.permissions.push(`${module}.view`);
    }
    if (
      baseContext.permissions.includes("inventory.post") &&
      !baseContext.permissions.includes("inventory.view")
    )
      baseContext.permissions.push("inventory.view");
    if (
      (baseContext.permissions.includes("finance.post") ||
        baseContext.permissions.includes("finance.manage")) &&
      !baseContext.permissions.includes("finance.view")
    )
      baseContext.permissions.push("finance.view");
  }
  const rows = await db.query(
    "SELECT * FROM page_settings WHERE company_id IS NULL OR company_id=$1",
    [companyId],
  );
  const global = new Map<string, QueryResultRow>(),
    local = new Map<string, QueryResultRow>();
  for (const row of rows.rows)
    (row.company_id === null ? global : local).set(row.page_key, row);
  const enabled = (key: string): boolean => {
    const definition = pageByKey(key)!;
    return (
      (global.get(key)?.enabled ?? true) &&
      (definition.scope === "company"
        ? (local.get(key)?.enabled ?? true)
        : true) &&
      (!definition.parentKey || enabled(definition.parentKey))
    );
  };
  return pageDefinitions.map((definition) => {
    const globalSetting = global.get(definition.key),
      localSetting =
        definition.scope === "company" ? local.get(definition.key) : undefined;
    const own = companyId ? localSetting : globalSetting;
    const isEnabled = enabled(definition.key);
    return {
      ...definition,
      id: definition.key,
      href: pageHref(definition, companyId),
      order: own?.sort_order ?? globalSetting?.sort_order ?? definition.order,
      visible:
        (globalSetting?.visible ?? definition.visible) &&
        (localSetting?.visible ?? true),
      enabled: isEnabled,
      globalVisible: globalSetting?.visible ?? definition.visible,
      globalEnabled: globalSetting?.enabled ?? true,
      configuredVisible:
        own?.visible ?? (companyId ? true : definition.visible),
      configuredEnabled: own?.enabled ?? true,
      revision: own?.revision ?? null,
      canConfigure:
        !definition.critical &&
        (companyId
          ? definition.scope === "company" &&
            (!!context?.general ||
              !!baseContext?.permissions.includes("pages.manage") ||
              effects.get("company.pages:edit") === "allow")
          : user.owner),
      actionAccess: Object.fromEntries(
        pageActions.map((action) => [
          action,
          isEnabled &&
            (!context?.general &&
            pagePermissionAliases(definition.key, action).some(
              (key) => effects.get(key) === "deny",
            )
              ? false
              : !context?.general &&
                  pagePermissionAliases(definition.key, action).some(
                    (key) =>
                      effects.get(key) === "allow" &&
                      definition.actions[action]?.permissions.every(
                        (permission) =>
                          requirementForAction(key).includes(permission),
                      ),
                  ) &&
                  definition.actions[action]?.role === "permissions"
                ? true
                : pageRuleAllows(
                    definition.actions[action],
                    user,
                    baseContext,
                  )),
        ]),
      ) as Record<PageAction, boolean>,
    };
  });
}
export function assertDirectoryAccess(
  entry: PageEntry,
  action: PageAction = "view",
) {
  if (!entry.enabled)
    throw new HttpError(
      403,
      "page_disabled",
      `صفحة «${entry.name}» معطلة؛ راجع مسؤول النطاق.`,
    );
  if (!entry.actionAccess[action])
    throw new HttpError(
      403,
      "forbidden",
      "لا تملك صلاحية هذا الإجراء في الصفحة.",
    );
}
export async function resolvePage(
  db: Database,
  user: User,
  reference: PageReference,
): Promise<ResolvedPage> {
  const definition = pageByKey(reference.pageKey);
  if (!definition) missing("الصفحة غير مسجلة في الدليل");
  if (definition.scope === "company" && !reference.companyId)
    throw new HttpError(
      400,
      "company_required",
      "اختر الشركة لفتح هذه الصفحة.",
    );
  if (definition.scope === "public" && reference.companyId)
    throw new HttpError(
      400,
      "invalid_reference",
      "الصفحة العامة لا ترتبط بشركة.",
    );
  if (!!definition.record !== !!reference.recordId)
    throw new HttpError(
      400,
      "invalid_reference",
      definition.record
        ? "أدخل معرف السجل المطلوب."
        : "هذه الصفحة لا تحتاج معرف سجل.",
    );
  const entries = await directoryEntries(db, user, reference.companyId);
  const entry = entries.find((entry) => entry.key === definition.key)!;
  assertDirectoryAccess(entry);
  if (definition.record) {
    const table = {
      item: "items",
      invoice: "invoices",
      "financial-document": "financial_documents",
      memo: "memos",
    }[definition.record];
    const record = await db.query(
      `SELECT id${definition.record === "memo" ? ",sender_user_id,current_user_id,current_employee_id" : definition.record === "item" ? "" : ",kind"} FROM ${table} WHERE company_id=$1 AND id=$2`,
      [reference.companyId, reference.recordId],
    );
    if (!record.rows[0]) missing();
    if (definition.record === "memo") {
      const context = await companyAccess(db, user, reference.companyId!);
      const memo = record.rows[0];
      const participant = await db.query(
        "SELECT 1 FROM memo_participants WHERE company_id=$1 AND memo_id=$2 AND user_id=$3 AND (employee_id IS NULL OR employee_id=$4)",
        [
          reference.companyId,
          reference.recordId,
          user.id,
          context.employee?.id ?? null,
        ],
      );
      const currentAssignee =
        memo.current_user_id === user.id &&
        (memo.current_employee_id === null ||
          memo.current_employee_id === context.employee?.id);
      const follower = await db.query(
        `SELECT 1 FROM memos m WHERE m.company_id=$1 AND m.id=$2 AND ${memoFollowerSql("m", "$3")}`,
        [reference.companyId, reference.recordId, context.employee?.id ?? null],
      );
      if (
        !context.general &&
        memo.sender_user_id !== user.id &&
        !currentAssignee &&
        !participant.rowCount &&
        !follower.rowCount
      )
        missing();
    }
    if (definition.record === "invoice")
      assertDirectoryAccess(
        entries.find(
          (entry) =>
            entry.key ===
            `company.${record.rows[0].kind === "sale" ? "sales" : "purchases"}`,
        )!,
      );
    if (definition.record === "financial-document")
      assertDirectoryAccess(
        entries.find(
          (entry) =>
            entry.key ===
            `company.${{ journal: "journals", receipt: "receipts", payment: "payments" }[record.rows[0].kind as "journal" | "receipt" | "payment"]}`,
        )!,
      );
  }
  return {
    reference,
    href: pageHref(definition, reference.companyId, reference.recordId)!,
    title: definition.name,
  };
}

// Flags are independent of the existing data/action authorization in each route.
// Recheck inside locked company mutations so a queued action cannot bypass a disable.
export async function requestPageKeys(
  db: Database,
  req: Request,
): Promise<{ companyId: number | null; keys: string[] }> {
  const path = req.originalUrl.split("?")[0]!.replace(/^\/api/, "");
  const company = path.match(/^\/companies\/([1-9]\d*)(?:\/(.*))?$/);
  if (!company) {
    const prefix = path.split("/")[1];
    return {
      companyId: null,
      keys:
        prefix === "notifications"
          ? ["public.notifications"]
          : prefix === "notification-templates"
            ? ["public.notification-templates"]
            : prefix === "users"
              ? ["public.users"]
              : prefix === "general-table"
                ? ["public.general-table"]
                : prefix === "audit"
                  ? ["public.audit"]
                  : [],
    };
  }
  if (
    !Number.isSafeInteger(Number(company[1])) ||
    Number(company[1]) > 2147483647
  )
    throw new HttpError(400, "invalid_id", "معرف غير صالح");
  const companyId = Number(company[1]),
    rest = company[2] ?? "",
    resource = rest.split("/")[0];
  const names: Record<string, string> = {
    employees: "employees",
    attendance: "attendance",
    wallet: "wallet",
    "reward-tasks": "reward-tasks",
    "wallet-settings": "wallet-settings",
    "wallet-conversions": "wallet-conversions",
    notifications: "notifications",
    memos: "memos",
    "notification-templates": "notification-templates",
    users: "employees",
    accounts: "accounts",
    "account-links": "accounts",
    currencies: "currencies",
    "finance-settings": "currencies",
    configuration: "configuration",
    "configuration-foundation": "configuration",
    "exchange-rates": "exchange-rates",
    branches: "branches",
    locations: "locations",
    items: "items",
    "item-options": "items",
    "item-agents": "item-agents",
    "stock-balances": "stock-balances",
    "stock-movements": "stock-movements",
    "stock-operations": "stock-operations",
    "stock-transfers": "stock-operations",
    "stock-adjustments": "stock-adjustments",
    "inventory-settings": "inventory-settings",
    "account-balances": "account-balances",
    "account-ledger": "account-ledger",
    audit: "audit",
    "financial-options": "financial-documents",
  };
  const keys = names[resource!] ? [`company.${names[resource!]}`] : [];
  if (resource === "transaction-reset")
    keys.push(
      "company.settings",
      "company.sales",
      "company.purchases",
      "company.financial-documents",
      "company.journals",
      "company.receipts",
      "company.payments",
      "company.stock-movements",
      "company.stock-operations",
      "company.stock-adjustments",
    );
  // Reading one's own attendance profile does not open the employee directory.
  if (
    resource === "employees" &&
    /^employees\/[1-9]\d*\/attendance-settings$/.test(rest)
  ) {
    if (req.method === "GET" || req.method === "HEAD")
      keys.splice(0, keys.length, "company.attendance");
    else keys.push("company.attendance");
  }
  if (
    resource === "memos" &&
    /^memos\/[1-9]\d*(?:\/(?:read|actions))?$/.test(rest)
  )
    keys.push("company.memo-detail");
  if (resource === "configuration" && rest.split("/")[1] === "record-options") {
    if (req.query.recordKind === "item")
      keys.push("company.items", "company.item-card");
    if (req.query.recordKind === "account") keys.push("company.accounts");
    if (req.query.recordKind === "employee") keys.push("company.employees");
  }
  if (!rest && ["PATCH", "PUT"].includes(req.method))
    keys.push("company.settings");
  if (
    [
      "commerce-options",
      "financial-options",
      "item-options",
      "inventory-options",
    ].includes(resource ?? "")
  ) {
    const types: Record<string, string> = {
      items: "items",
      accounts: "accounts",
      currencies: "currencies",
      branches: "branches",
      locations: "locations",
      agents: "item-agents",
    };
    const type =
      typeof req.query.type === "string" ? types[req.query.type] : undefined;
    if (type) keys.push(`company.${type}`);
  }
  if (resource === "items") {
    if (req.method === "POST" && rest === "items")
      keys.push("company.item-new");
    if (/^items\/\d+/.test(rest)) keys.push("company.item-card");
  }
  if (
    resource === "wallet-conversions" &&
    req.method === "POST" &&
    (rest === "wallet-conversions" ||
      /^wallet-conversions\/[1-9]\d*\/approve$/.test(rest))
  )
    keys.push("company.wallet");
  if (resource === "financial-documents" || resource === "invoices") {
    const financial = resource === "financial-documents";
    let kind: unknown =
      req.method === "POST" && rest === resource
        ? req.body?.kind
        : req.query.kind;
    const match = rest.match(/^[a-z-]+\/([1-9]\d*)/);
    if (match) {
      if (
        !Number.isSafeInteger(Number(match[1])) ||
        Number(match[1]) > 2147483647
      )
        throw new HttpError(400, "invalid_id", "معرف غير صالح");
      await companyAccess(
        db,
        req.auth!.user,
        companyId,
        financial ? "finance.view" : "commerce.view",
      );
      const record = await db.query(
        `SELECT kind FROM ${financial ? "financial_documents" : "invoices"} WHERE company_id=$1 AND id=$2`,
        [companyId, Number(match[1])],
      );
      kind = record.rows[0]?.kind;
      keys.push(financial ? "company.financial-document" : "company.invoice");
    }
    const types = financial
      ? { journal: "journals", receipt: "receipts", payment: "payments" }
      : { sale: "sales", purchase: "purchases" };
    if (typeof kind === "string" && Object.hasOwn(types, kind))
      keys.push(`company.${types[kind as keyof typeof types]}`);
    else keys.push(...Object.values(types).map((name) => `company.${name}`));
    if (financial) keys.push("company.financial-documents");
    if (req.method === "POST" && rest === resource) {
      if (financial) keys.push("company.financial-new");
      else if (kind === "sale" || kind === "purchase")
        keys.push(`company.${kind === "sale" ? "sale" : "purchase"}-new`);
    }
  }
  return { companyId, keys };
}
export async function assertRequestPagesEnabled(
  db: Database,
  req: Request,
  locked = false,
): Promise<void> {
  if (!req.auth) return;
  const { companyId, keys } = await requestPageKeys(db, req);
  for (let index = 0; index < keys.length; index++) {
    const parent = pageByKey(keys[index]!)?.parentKey;
    if (parent && !keys.includes(parent)) keys.push(parent);
  }
  if (!keys.length) return;
  // Confirming a previously accepted UUID must remain possible after a disable.
  // Route authorization and its canonical payload comparison still run, and
  // a changed payload can only fail with conflict, never create a new record.
  const path = req.originalUrl.split("?")[0]!.replace(/^\/api/, "");
  const creation = path.match(
    /^\/companies\/[1-9]\d*\/(items|item-agents|invoices|financial-documents|stock-transfers|stock-adjustments|wallet\/awards|wallet\/reversals|wallet-conversions|memos|attendance\/adjustments)$/,
  );
  const requestKey: unknown = req.body?.idempotencyKey;
  if (
    companyId &&
    req.method === "POST" &&
    creation &&
    typeof requestKey === "string" &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestKey)
  ) {
    const tables: Record<string, string> = {
      items: "items",
      "item-agents": "item_agents",
      invoices: "invoices",
      "financial-documents": "financial_documents",
      "stock-transfers": "stock_operations",
      "stock-adjustments": "stock_operations",
      "wallet/awards": "employee_wallet_entries",
      "wallet/reversals": "employee_wallet_entries",
      "wallet-conversions": "wallet_conversions",
      memos: "memos",
      "attendance/adjustments": "attendance_point_entries",
    };
    const existing = await db.query(
      `SELECT 1 FROM ${tables[creation[1]!]} WHERE company_id=$1 AND idempotency_key=$2`,
      [companyId, requestKey],
    );
    if (existing.rowCount) return;
  }
  const decision = path.match(
    /^\/companies\/[1-9]\d*\/wallet-conversions\/([1-9]\d*)\/(approve|reject|cancel)$/,
  );
  if (
    companyId &&
    req.method === "POST" &&
    decision &&
    typeof requestKey === "string" &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestKey)
  ) {
    const existing = await db.query(
      "SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND id=$2 AND decision_key=$3",
      [companyId, decision[1], requestKey],
    );
    if (existing.rowCount) return;
  }
  const memoAction = path.match(
    /^\/companies\/[1-9]\d*\/memos\/([1-9]\d*)\/actions$/,
  );
  if (
    companyId &&
    req.method === "POST" &&
    memoAction &&
    typeof requestKey === "string" &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestKey)
  ) {
    const existing = await db.query(
      "SELECT 1 FROM memo_actions WHERE company_id=$1 AND memo_id=$2 AND idempotency_key=$3",
      [companyId, memoAction[1], requestKey],
    );
    if (existing.rowCount) return;
  }
  if (locked)
    await db.query(
      "SELECT key FROM page_registry WHERE key=ANY($1::text[]) ORDER BY key FOR SHARE",
      [keys],
    );
  const settings = await db.query(
    "SELECT page_key,enabled FROM page_settings WHERE page_key=ANY($1::text[]) AND (company_id IS NULL OR company_id=$2)",
    [keys, companyId],
  );
  const disabled = settings.rows.find((row) => !row.enabled);
  if (disabled)
    throw new HttpError(
      403,
      "page_disabled",
      `صفحة «${pageByKey(disabled.page_key)!.name}» معطلة؛ راجع مسؤول النطاق.`,
    );
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import type { Database } from "../db.ts";
import {
  pageByKey,
  type PageAction,
  type Permission,
} from "../../../../packages/contracts/src/index.ts";

export type RuleEffect = "allow" | "deny";
export const permissionRequest = new AsyncLocalStorage<Request>();
const actionKey = (page: string, action: PageAction) =>
  pageByKey(page)?.actions[action] ? `${page}:${action}` : null;

/** Pages sharing the same operation share deny checks, including direct URLs. */
export function pagePermissionAliases(
  page: string,
  action: PageAction,
): string[] {
  const pages = [page];
  if (page === "company.item-card" || page === "company.item-new")
    pages.push("company.items");
  if (
    [
      "company.financial-document",
      "company.financial-new",
      "company.journals",
      "company.receipts",
      "company.payments",
    ].includes(page)
  )
    pages.push("company.financial-documents");
  if (page === "company.sale-new") pages.push("company.sales");
  if (page === "company.purchase-new") pages.push("company.purchases");
  if (page === "company.memo-detail") pages.push("company.memos");
  return [
    ...new Set(
      pages
        .map((key) => actionKey(key, action))
        .filter((key): key is string => !!key),
    ),
  ];
}

/** Each group must be authorized; mixed lists cannot inherit a single kind's grant. */
export async function requestPermissionTargets(
  db: Database,
  req: Request | undefined,
  companyId: number,
  permission?: Permission,
): Promise<string[][]> {
  if (!req) return [];
  const path = req.originalUrl.split("?")[0]?.replace(/^\/api/, "") ?? "";
  if (
    req.method === "PUT" &&
    /^\/page-catalog\/[^/]+\/settings$/.test(path) &&
    req.body?.companyId === companyId
  )
    return [["company.pages:edit"]];
  const prefix = `/companies/${companyId}`;
  if (path !== prefix && !path.startsWith(prefix + "/")) return [];
  const segments = path.slice(prefix.length).split("/").filter(Boolean);
  const [resource = "", detail] = segments;
  const verb = req.method;
  let action: PageAction =
    verb === "GET" || verb === "HEAD"
      ? "view"
      : verb === "POST"
        ? "create"
        : "edit";
  if (!resource) return action === "view" ? [] : [["company.settings:edit"]];
  if (resource === "account-statistics-report")
    return [
      pagePermissionAliases("company.accounts", "view"),
      pagePermissionAliases("company.account-ledger", "view"),
      pagePermissionAliases("company.account-statistics", "view"),
    ];
  if (
    resource === "accounts" &&
    detail &&
    /^[1-9]\d*$/.test(detail) &&
    segments.length === 3 &&
    ((["GET", "HEAD"].includes(verb) && segments[2] === "statistics") ||
      (verb === "POST" &&
        ["balance-followups", "balance-approvals"].includes(segments[2]!)))
  ) {
    // These are actions on an existing balance, never account creation. Their
    // exact grants are checked independently by assertAccountBalanceAccess;
    // returning each view/action separately also preserves explicit deny checks.
    return [
      pagePermissionAliases("company.accounts", "view"),
      pagePermissionAliases("company.account-ledger", "view"),
      pagePermissionAliases("company.account-statistics", "view"),
      ...(verb === "POST"
        ? [
            pagePermissionAliases(
              "company.account-statistics",
              segments[2] === "balance-followups" ? "create" : "post",
            ),
          ]
        : []),
    ];
  }
  const direct: Record<string, string> = {
    accounts: "company.accounts",
    "account-links": "company.accounts",
    currencies: "company.currencies",
    "finance-settings": "company.currencies",
    "exchange-rates": "company.exchange-rates",
    branches: "company.branches",
    locations: "company.locations",
    employees: "company.employees",
    attendance: "company.attendance",
    wallet: "company.wallet",
    "reward-tasks": "company.reward-tasks",
    "wallet-settings": "company.wallet-settings",
    "wallet-conversions": "company.wallet-conversions",
    notifications: "company.notifications",
    memos: "company.memos",
    "notification-templates": "company.notification-templates",
    users: "company.employees",
    "item-agents": "company.item-agents",
    "item-options": "company.items",
    "inventory-settings": "company.inventory-settings",
    "stock-balances": "company.stock-balances",
    "stock-movements": "company.stock-movements",
    "stock-operations": "company.stock-operations",
    "stock-transfers": "company.stock-operations",
    "stock-adjustments": "company.stock-operations",
    "account-balances": "company.account-balances",
    "account-ledger": "company.account-ledger",
    audit: "company.audit",
    configuration: "company.configuration",
    control: "company.control",
    "configuration-foundation": "company.configuration",
    "financial-options": "company.financial-documents",
    "purchase-history": "company.purchases",
    "commerce-options": "company.sales",
    "inventory-options": "company.stock-operations",
  };
  if (resource === "notifications" && verb === "POST") action = "edit";
  if (resource === "employees" && segments[2] === "attendance-settings")
    return [
      pagePermissionAliases("company.attendance", "view"),
      ...(verb === "GET" || verb === "HEAD"
        ? []
        : [
            pagePermissionAliases("company.attendance", "edit"),
            pagePermissionAliases("company.employees", "edit"),
          ]),
    ];
  if (resource === "attendance") {
    if (detail === "adjustments" && verb === "POST") action = "edit";
    return [
      pagePermissionAliases("company.attendance", "view"),
      ...(action === "view"
        ? []
        : [pagePermissionAliases("company.attendance", action)]),
    ];
  }
  if (resource === "memo-feature-rules")
    return [
      pagePermissionAliases("company.memo-feature-rules", "view"),
      ...(["POST", "PUT", "PATCH"].includes(verb)
        ? [pagePermissionAliases("company.memo-feature-rules", "edit")]
        : []),
    ];
  if (resource === "memos") {
    const memoDetail = !!detail && /^[1-9]\d*$/.test(detail);
    return [
      pagePermissionAliases(
        memoDetail ? "company.memo-detail" : "company.memos",
        "view",
      ),
      ...(verb === "POST" && !detail
        ? [pagePermissionAliases("company.memos", "create")]
        : []),
      ...(verb === "PUT" && segments[2] === "schedule"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "PUT" && segments[2] === "reminder-settings"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "PUT" && segments[2] === "options"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "PUT" && segments[2] === "links"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "PUT" && segments[2] === "followers"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "POST" && segments[2] === "comments"
        ? [pagePermissionAliases("company.memos", "edit")]
        : []),
      ...(verb === "POST" && segments[2] === "actions"
        ? [
            pagePermissionAliases(
              "company.memos",
              [
                "request-completion",
                "approve-completion",
                "reopen-completion",
                "complete",
              ].includes(req.body?.action)
                ? "post"
                : "edit",
            ),
          ]
        : []),
    ];
  }
  if (resource === "wallet" && detail === "reversals" && verb === "POST")
    action = "reverse";
  if (resource === "wallet-conversions" && verb === "POST") {
    if (segments[2] === "approve" || segments[2] === "reject") action = "post";
    if (segments[2] === "cancel") action = "edit";
    return [
      pagePermissionAliases("company.wallet-conversions", action),
      pagePermissionAliases("company.wallet-conversions", "view"),
      ...(!detail || segments[2] === "approve"
        ? [pagePermissionAliases("company.wallet", "view")]
        : []),
    ];
  }
  let page = direct[resource];
  if (resource === "commerce-options" && permission === "inventory.view")
    page = "company.stock-balances";
  if (resource === "control") action = "view";
  if (resource === "configuration") {
    action = action === "view" ? "view" : "edit";
    if (detail === "record-options")
      page =
        req.query.recordKind === "item"
          ? "company.item-card"
          : req.query.recordKind === "employee"
            ? "company.employees"
            : "company.accounts";
  }
  if (resource === "items")
    page =
      action === "create" && !detail
        ? "company.item-new"
        : detail && /^\d+$/.test(detail)
          ? "company.item-card"
          : "company.items";
  if (resource === "stock-transfers" || resource === "stock-adjustments")
    action = "create";
  if (resource === "financial-documents" || resource === "invoices") {
    const financial = resource === "financial-documents";
    let kind: unknown =
      verb === "POST" && !detail ? req.body?.kind : req.query.kind;
    if (detail && /^[1-9]\d*$/.test(detail)) {
      const row = await db.query(
        `SELECT kind FROM ${financial ? "financial_documents" : "invoices"} WHERE company_id=$1 AND id=$2`,
        [companyId, detail],
      );
      kind = row.rows[0]?.kind;
    }
    if (segments[2] === "post") action = "post";
    if (segments[2] === "reverse") action = "reverse";
    if (financial && segments[2] === "print-request" && verb === "POST")
      action = "print";
    const kinds = financial
      ? { journal: "journals", receipt: "receipts", payment: "payments" }
      : { sale: "sales", purchase: "purchases" };
    const included =
      typeof kind === "string" && Object.hasOwn(kinds, kind)
        ? [kind]
        : Object.keys(kinds);
    return included.flatMap((type) => {
      const parent = `company.${kinds[type as keyof typeof kinds]}`;
      const primary = financial
        ? !detail && verb === "POST"
          ? "company.financial-new"
          : detail
            ? "company.financial-document"
            : "company.financial-documents"
        : !detail && verb === "POST"
          ? `company.${type === "sale" ? "sale" : "purchase"}-new`
          : detail
            ? "company.invoice"
            : parent;
      const targets = [
        [
          ...new Set([
            ...pagePermissionAliases(primary, action),
            ...pagePermissionAliases(parent, action),
          ]),
        ],
      ];
      // A print reward is a print action, and also requires current access to
      // the document. A print allow never bypasses an explicit view denial.
      if (action === "print")
        targets.push([
          ...new Set([
            ...pagePermissionAliases(primary, "view"),
            ...pagePermissionAliases(parent, "view"),
          ]),
        ]);
      return targets;
    });
  }
  const aliases = page ? pagePermissionAliases(page, action) : [];
  if (
    [
      "commerce-options",
      "financial-options",
      "item-options",
      "inventory-options",
    ].includes(resource)
  ) {
    const types: Record<string, string> = {
      items: "items",
      accounts: "accounts",
      currencies: "currencies",
      branches: "branches",
      locations: "locations",
      agents: "item-agents",
    };
    const target =
      typeof req.query.type === "string" ? types[req.query.type] : undefined;
    if (target)
      aliases.push(...pagePermissionAliases(`company.${target}`, "view"));
  }
  return aliases.length ? [aliases] : [];
}

export async function permissionRuleEffects(
  db: Database,
  companyId: number,
  employeeId: number,
) {
  const found = await db.query(
    `
    SELECT r.permission_key,r.effect FROM employee_permission_rules r
    JOIN permission_definitions d ON d.key=r.permission_key AND d.active
    WHERE r.company_id=$1 AND r.employee_id=$2 AND r.active
    UNION ALL
    SELECT r.permission_key,r.effect FROM role_permission_rules r
    JOIN permission_definitions d ON d.key=r.permission_key AND d.active
    JOIN company_roles roles ON roles.company_id=r.company_id AND roles.id=r.role_id AND roles.active
    JOIN employee_role_assignments a ON a.company_id=r.company_id AND a.role_id=r.role_id AND a.employee_id=$2 AND a.active
    WHERE r.company_id=$1 AND r.active`,
    [companyId, employeeId],
  );
  const map = new Map<string, RuleEffect>();
  for (const row of found.rows)
    if (row.effect === "deny" || !map.has(row.permission_key))
      map.set(row.permission_key, row.effect);
  return map;
}
export function requirementForAction(key: string): Permission[] {
  const split = key.lastIndexOf(":");
  if (split < 0) return [];
  const rule = pageByKey(key.slice(0, split))?.actions[
    key.slice(split + 1) as PageAction
  ];
  if (rule?.role !== "permissions") return [];
  const permissions = [...rule.permissions];
  for (const module of [
    "accounts",
    "currencies",
    "locations",
    "items",
    "commerce",
    "inventory",
    "finance",
  ] as const) {
    if (
      (permissions.includes(`${module}.manage`) ||
        ((module === "inventory" || module === "finance") &&
          permissions.includes(`${module}.post`))) &&
      !permissions.includes(`${module}.view`)
    )
      permissions.push(`${module}.view`);
  }
  return permissions;
}

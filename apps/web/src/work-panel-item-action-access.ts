import type { CompanyContext, PageEntry } from "../../../packages/contracts/src/index";
import type { InvoiceItemAction } from "./InvoiceItemActionsDropdown";

export function workPanelItemActionAccess(context: CompanyContext | undefined,
  directory: PageEntry[] | undefined): Record<InvoiceItemAction, boolean> {
  const page = (key: string) => directory?.find(entry => entry.key === key);
  const permitted = (key: string, ...actions: ("view" | "create" | "edit")[]) => {
    const entry = page(key);
    return !!entry?.enabled && actions.every(action => entry.actionAccess[action]);
  };
  const granted = (key: CompanyContext["permissions"][number]) =>
    !!context && (context.general || context.permissions.includes(key));
  return {
    "public-request": !!context && permitted("company.public-requests", "create"),
    edit: granted("items.manage") && permitted("company.items", "view", "edit") &&
      permitted("company.item-card", "view", "edit"),
    adjust: granted("inventory.post") && granted("finance.post") &&
      permitted("company.stock-adjustments", "view", "create"),
    transfer: granted("inventory.post") && permitted("company.stock-operations", "view"),
    report: !!context && permitted("company.memos", "view", "create"),
  };
}

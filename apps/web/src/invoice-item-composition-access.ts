import type { CompanyContext,Item,PageEntry } from "../../../packages/contracts/src/index";

export function canEditInvoiceItemComposition(context:CompanyContext|undefined,directory:PageEntry[]|undefined) {
  if(!context || (!context.general&&!context.permissions.includes("items.manage"))) return false;
  const page=directory?.find(entry=>entry.key==="company.item-compositions");
  return !!page?.enabled && page.actionAccess.view && page.actionAccess.edit;
}

export function exactInvoiceItemCompositionId(item:Pick<Item,"companyId"|"id"|"compositionId">|undefined,
  companyId:number|undefined,itemId:number):number|null {
  if(!item||item.companyId!==companyId||item.id!==itemId||item.compositionId==null||
     !Number.isSafeInteger(item.compositionId)||item.compositionId<=0) return null;
  return item.compositionId;
}

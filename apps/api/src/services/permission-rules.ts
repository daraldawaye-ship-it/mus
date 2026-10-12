import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import type { Database } from "../db.ts";
import { pageByKey, type PageAction, type Permission } from "../../../../packages/contracts/src/index.ts";

export type RuleEffect = "allow" | "deny";
export const permissionRequest = new AsyncLocalStorage<Request>();

/** Map the specific API operation, not merely its module, to a page action.
 * No page-specific grant may become a blanket module grant. */
export function requestPermissionAction(req:Request|undefined, companyId:number):string|null {
  if(!req)return null;
  const path=req.originalUrl.split("?")[0]?.replace(/^\/api/,"")??"";
  const prefix=`/companies/${companyId}/`;
  if(!path.startsWith(prefix))return null;
  const segments=path.slice(prefix.length).split("/").filter(Boolean);
  const resource=segments[0]??"", detail=segments[1],verb=req.method;
  const operation:PageAction=verb==="GET"?"view":verb==="POST"?"create":"edit";
  const direct:Record<string,string>={
    accounts:"company.accounts", "account-links":"company.accounts",
    currencies:"company.currencies","finance-settings":"company.currencies",
    "exchange-rates":"company.exchange-rates",
    branches:"company.branches",locations:"company.locations",
    employees:"company.employees",users:"company.employees",
    "item-agents":"company.item-agents",
    "inventory-settings":"company.inventory-settings",
    "stock-balances":"company.stock-balances",
    "stock-movements":"company.stock-movements",
    "stock-operations":"company.stock-operations",
    "stock-transfers":"company.stock-operations",
    "stock-adjustments":"company.stock-operations",
    "account-balances":"company.account-balances",
    "account-ledger":"company.account-ledger",
    audit:"company.audit",configuration:"company.configuration",
    "configuration-foundation":"company.configuration",
    "financial-options":"company.financial-documents",
    "commerce-options":"company.sales", "item-options":"company.items",
    "inventory-options":"company.stock-operations",
  };
  let pageKey=direct[resource], action=operation;
  if(resource==="configuration" && detail==="record-options"){
    const kind=req.query.recordKind;
    pageKey=kind==="item"?"company.item-card":kind==="account"?"company.accounts":undefined;
  }
  if(resource==="items")pageKey=verb==="POST"&&!detail?"company.item-new":detail&&/^\d+$/.test(detail)?"company.item-card":"company.items";
  if(resource==="financial-documents") {
    pageKey=verb==="POST"&&!detail?"company.financial-new":detail&&/^\d+$/.test(detail)?"company.financial-document":"company.financial-documents";
    if(segments[2]==="post")action="post";
    if(segments[2]==="reverse")action="reverse";
  }
  if(resource==="invoices") {
    pageKey=verb==="POST"&&!detail?
      req.body?.kind==="purchase"?"company.purchase-new":"company.sale-new":
      detail&&/^\d+$/.test(detail)?"company.invoice":
      req.query.kind==="purchase"?"company.purchases":"company.sales";
  }
  if(resource==="stock-transfers"||resource==="stock-adjustments")action="create";
  if(!pageKey)return null;
  const definition=pageByKey(pageKey);
  // Do not invent actions: a route with an unsupported action continues to
  // be protected by its original legacy permission checks.
  if(!definition?.actions[action])return null;
  return pageKey+":"+action;
}

export async function permissionRuleEffects(db:Database,companyId:number,employeeId:number) {
  const found=await db.query(`
    SELECT permission_key,effect FROM employee_permission_rules
    WHERE company_id=$1 AND employee_id=$2 AND active
    UNION ALL
    SELECT r.permission_key,r.effect
    FROM role_permission_rules r
    JOIN company_roles roles ON roles.company_id=r.company_id AND roles.id=r.role_id AND roles.active
    JOIN employee_role_assignments a ON a.company_id=r.company_id AND a.role_id=r.role_id
      AND a.employee_id=$2 AND a.active
    WHERE r.company_id=$1 AND r.active
  `,[companyId,employeeId]);
  const map=new Map<string,RuleEffect>();
  for(const row of found.rows){
    const previous=map.get(row.permission_key);
    if(row.effect==="deny"||!previous)map.set(row.permission_key,row.effect);
  }
  return map;
}
export function requirementForAction(key:string):Permission[] {
  const split=key.lastIndexOf(":");
  if(split<0)return [];
  const action=key.slice(split+1) as PageAction;
  return pageByKey(key.slice(0,split))?.actions[action]?.permissions??[];
}

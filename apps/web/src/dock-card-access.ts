type CardPage = {key:string;scope:"public"|"company";enabled:boolean;actionAccess:{view:boolean}};
type CardContext={company:{id:number};general:boolean; permissions:readonly string[]};

export const isDockEntityId=(id:unknown):id is number=>typeof id==="number"&&Number.isSafeInteger(id)&&id>0&&id<=2_147_483_647;
export const dockCanViewPage=(pages:readonly CardPage[]|undefined,key:string)=>
  !!pages?.some(page=>page.key===key&&page.enabled&&page.actionAccess.view);

export function dockAccountAccess(context:CardContext|undefined,pages:readonly CardPage[]|undefined){
  return {
    card:!!context&&(context.general||context.permissions.includes("accounts.view"))&&dockCanViewPage(pages,"company.accounts"),
    ledger:!!context&&(context.general||context.permissions.includes("finance.view"))&&dockCanViewPage(pages,"company.account-ledger"),
  };
}

export function dockAccountCardPath(companyId:number,accountId:number){
  return isDockEntityId(companyId)&&isDockEntityId(accountId)
    ? `/companies/${companyId}/accounts/${accountId}` : null;
}

export function dockVerifiedAccount<T extends {id:number;companyId:number}>(account:T|undefined,companyId:number,id:number){
  return account?.id===id&&account.companyId===companyId ? account : undefined;
}

export function dockPageCardEntry<T extends CardPage>(pages:readonly T[]|undefined,key:string|undefined,
  companyId:number|undefined){
  const entry=pages?.find(page=>page.key===key&&page.enabled&&page.actionAccess.view);
  return entry && (entry.scope==="public" || isDockEntityId(companyId)) ? entry : undefined;
}

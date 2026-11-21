type Actor={owner:boolean; suspended:boolean; archived:boolean};
type Context={general:boolean; permissions:readonly string[];
  employee?:{active:boolean;positions:readonly string[]}|null};
type Page={key:string;enabled:boolean;actionAccess:{view:boolean}};
export function dockContainerRoles(user:Actor|null|undefined, company:Context|undefined,
  actualCompany:boolean, visitor:boolean, preview:boolean) {
  const shell=!!user&&!visitor&&!preview;
  const owner=shell&&!!user?.owner&&!user.archived&&!user.suspended;
  const employee=shell&&actualCompany&&!user?.archived&&!user?.suspended&&company?.employee?.active
    ? company.employee : null;
  const cashier=!!employee?.positions.includes("cashier");
  const staff=cashier||!!employee?.positions.includes("sales");
  return {shell,owner,item:owner||staff,account:owner||cashier,
    user:owner,page:owner,overview:actualCompany&&(owner||staff)};
}
export function dockDataReads(company:Context|undefined, pages:readonly Page[]|undefined) {
  const p=(key:string)=>!!pages?.some(e=>e.key===key&&e.enabled&&e.actionAccess.view);
  const can=(key:string)=>!!company&&(company.general||company.permissions.includes(key));
  const movement=can("inventory.view")&&p("company.stock-movements");
  return {
    item: ["commerce.view","inventory.view","items.view"].some(can),
    account: (can("finance.view")&&p("company.financial-documents"))||(can("accounts.view")&&p("company.accounts")),
    movement,
    purchases: movement&&p("company.purchases"),
    alternatives: can("items.view")&&p("company.items")&&p("company.item-card"),
    card: can("items.view")&&p("company.items")&&p("company.item-card"),
  };
}

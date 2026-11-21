import {pageHref,type PageEntry} from "../../../packages/contracts/src/index";

export type CompanyShortcutGroup = "items"|"accounts"|"operations"|"administration";
type Shortcut = {key:string;label:string;href:string;action:"view"|"create";order:number};
type DirectoryPage = PageEntry & {showOnCompanyOverview?:boolean};
const existingItems = new Set([
  "company.sale-new","company.sales","company.purchase-new","company.purchases",
  "company.item-options-list","company.public-requests","company.stock-movements","company.doctors",
  "company.doctor-sales-movements","company.doctor-movement-comparison","company.items",
  "company.item-statistics-report","company.item-compositions","company.item-form-differences",
  "company.settlement-follow-up","company.stock-balances",
]);
const existingAccounts=new Set([
  "company.administrative-custody","company.accounts","company.account-balances","company.account-ledger",
  "company.slip-movements","company.my-cashbox-ledger","company.account-statistics","company.sales-time-report",
  "company.trial-balance","company.cash-flows","company.financial-documents","company.financial-new",
  "company.journals","company.receipts","company.payments","company.pouch-receipts","company.electronic-receipts",
  "company.currencies","company.exchange-rates",
]);
const administration = new Set([
  "company.control","company.configuration","company.central-access","company.approved-devices",
  "company.notification-templates","company.letterhead","company.branches","company.locations","company.employees",
  "company.settings","company.audit","company.memo-feature-rules",
]);
const createShortcutKeys=new Set(["company.item-new","company.sale-new","company.purchase-new","company.financial-new"]);
const legacyLabels:Record<string,string>={
  "company.approved-devices":"الأجهزة",
  "company.central-access":"مركز الصلاحيات وخيارات النظام",
  "company.notification-templates":"أنواع التنبيهات",
  "company.letterhead":"ترويسة الشركة للطباعة",
  "company.locations":"المعارض والمخازن",
};

function groupFor(entry:DirectoryPage,byKey:ReadonlyMap<string,DirectoryPage>,seen=new Set<string>()):CompanyShortcutGroup{
  if(existingItems.has(entry.key))return "items";
  if(existingAccounts.has(entry.key))return "accounts";
  if(administration.has(entry.key)||["إدارة المنصة","الإدارة والصلاحيات","التدقيق"].includes(entry.section))return "administration";
  if(["الأصناف والمخزون","الفواتير","المبيعات"].includes(entry.section))return "items";
  if(["المحاسبة","الحسابات"].includes(entry.section))return "accounts";
  if(entry.parentKey && !seen.has(entry.key)){
    const parent=byKey.get(entry.parentKey);
    if(parent)return groupFor(parent,byKey,new Set([...seen,entry.key]));
  }
  return "operations";
}

export function companyOverviewShortcuts(directory:readonly DirectoryPage[]|undefined,companyId:number) {
  const groups:Record<CompanyShortcutGroup,Shortcut[]>={items:[],accounts:[],operations:[],administration:[]};
  const entries=(directory??[]).filter(entry=>entry.scope==="company");
  const byKey=new Map(entries.map(entry=>[entry.key,entry]));
  const used=new Set<string>();
  for(const entry of [...entries].sort((a,b)=>a.order-b.order||a.key.localeCompare(b.key))) {
    if(entry.key==="company.pages"||entry.record||!entry.visible||!entry.enabled||
       !entry.actionAccess.view||entry.showOnCompanyOverview===false)continue;
    const action=createShortcutKeys.has(entry.key)?"create":"view";
    if(action==="create"&&!entry.actionAccess.create)continue;
    const href=pageHref(entry,companyId);
    if(!href||entry.href!==href||!/^\/(?![\/\\])[^\\\s]*$/.test(href)||
       (href!==`/companies/${companyId}`&&!href.startsWith(`/companies/${companyId}/`)))continue;
    if(used.has(href))continue;
    used.add(href);
    const group=groupFor(entry,byKey);
    groups[group].push({key:entry.key,label:legacyLabels[entry.key]??entry.name,href,action,order:entry.order});
    // Follow-up is an existing standalone route sharing the catalogue access
    // rule of the item options list. Keep it next to its parent shortcut.
    if(entry.key==="company.item-options-list"){
      const drafts=`/companies/${companyId}/item-order-drafts`;
      if(!entries.some(candidate=>candidate.href===drafts)&&!used.has(drafts)){
        groups.items.push({key:"item-order-drafts-shortcut",label:"متابعة مسودات الطلبيات",href:drafts,action:"view",order:entry.order});
        used.add(drafts);
      }
    }
  }
  return groups;
}

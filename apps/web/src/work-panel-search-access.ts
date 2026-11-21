type SearchActor = { owner:boolean; kind:string };
type AccessiblePage = {
  key:string; name:string; order:number; scope:"public"|"company"; href?:string|null;
  visible:boolean; enabled:boolean; navigation:boolean; actionAccess:{view:boolean};
};

export const accountSearchPermission = "work-panel.account-search";
export const pageSearchPermission = "work-panel.page-search";
type SearchCompany={employee?:{permissions:readonly string[]}|null; permissions:readonly string[]};

export function showWorkPanelAccountSearch(
  user:SearchActor|null|undefined, company:SearchCompany|undefined, pages:readonly AccessiblePage[]|undefined, preview:boolean,
) {
  if (!user || preview) return false;
  if (user.owner) return true;
  return !!company?.employee?.permissions.includes(accountSearchPermission) &&
    (company.permissions.includes("accounts.view") || company.permissions.includes("finance.view")) &&
    !!pages?.some(entry=>entry.enabled && entry.actionAccess.view &&
      ["company.accounts","company.financial-documents"].includes(entry.key));
}

export function showWorkPanelPageSearch(user:SearchActor|null|undefined,
  company:SearchCompany|undefined, preview:boolean){
  return !!user && !preview && (user.owner || !!company?.employee?.permissions.includes(pageSearchPermission));
}

/** Shared with the actual sidebar; this is visibility, never a route/API grant. */
export function isVisibleNavigationPage(entry:AccessiblePage,user:SearchActor|null|undefined) {
  return !!(entry.navigation && entry.href && entry.visible && entry.enabled && entry.actionAccess.view &&
    (user?.owner || user?.kind==="admin" || !["public.users","public.chat"].includes(entry.key)));
}

const localPath=/^\/(?![\/\\])[^\\\s]*$/;
const normalize=(value:string)=>value.normalize("NFKC").toLocaleLowerCase("ar").replace(/[\u0640\u064B-\u065F]/g,"").replace(/[أإآٱ]/g,"ا").trim();
export function findWorkPanelPages(pages:readonly AccessiblePage[]|undefined, user:SearchActor,
  companyId:number|undefined,query:string) {
  const search=normalize(query);
  if(!pages || !search)return [];
  const unique=new Set<string>();
  return [...pages].sort((a,b)=>a.order-b.order||a.key.localeCompare(b.key)).flatMap(entry=>{
    if(!isVisibleNavigationPage(entry,user)||!entry.href||!localPath.test(entry.href))return [];
    if(entry.scope==="company" && (!companyId || !(entry.href===`/companies/${companyId}` ||
        entry.href.startsWith(`/companies/${companyId}/`))))return [];
    if(!normalize(entry.name).includes(search))return [];
    const href=entry.key==="public.home"?"/medicine-market":entry.href;
    if(unique.has(href))return [];
    unique.add(href);
    return [{key:entry.key,name:entry.name,href}];
  }).slice(0,10);
}

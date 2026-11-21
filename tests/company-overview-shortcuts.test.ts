import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {pageDefinitions,pageHref,type PageDefinition,type PageEntry} from "../packages/contracts/src/index.ts";
import {companyOverviewShortcuts} from "../apps/web/src/company-overview-shortcuts.ts";

const companyId=2;
const actions={view:true,create:true,edit:false,post:false,reverse:false,delete:false,print:false,export:false};
function entry(page:PageDefinition,overrides:Partial<PageEntry>={}):PageEntry{
  return {...page,href:pageHref(page,companyId),id:page.key,enabled:true,configuredVisible:page.visible,
    configuredEnabled:true,showOnCompanyOverview:true,globalEnabled:true,globalVisible:page.visible,revision:null,canConfigure:false,actionAccess:actions,...overrides};
}
const fromKey=(key:string)=>pageDefinitions.find(page=>page.key===key)!;
test("directory contributes every independently linkable and allowed page exactly once across four groups",()=>{
  const entries=pageDefinitions.map(page=>entry(page)).reverse();
  const grouped=companyOverviewShortcuts(entries,companyId,true);
  const all=Object.values(grouped).flat();
  const expected=entries.filter(page=>page.visible&&page.href&&page.key!=="company.pages").map(page=>page.href!);
  for(const href of expected)assert.equal(all.filter(shortcut=>shortcut.href===href).length,1,href);
  assert.equal(all.length, new Set(expected).size+2,"retain the two pre-existing non-catalogue shortcuts");
  assert.equal(all.some(link=>link.key==="company.pages"),false);
  assert.ok(grouped.items.some(link=>link.key==="company.sales"));
  assert.ok(grouped.items.some(link=>link.key==="public.medicine-market"));
  assert.ok(grouped.accounts.some(link=>link.key==="company.account-statistics"));
  assert.ok(grouped.operations.some(link=>link.key==="company.attendance"));
  assert.ok(grouped.operations.some(link=>link.key==="public.pages"&&link.label==="قائمة صفحات الموقع العام"));
  assert.ok(grouped.administration.some(link=>link.key==="company.central-access"));
  assert.ok(grouped.administration.some(link=>link.href==="/design-library"));
  assert.equal(grouped.administration.find(link=>link.href==="/owner-sql")?.action,"view");
  assert.ok(grouped.items.some(link=>link.href==="/companies/2/item-order-drafts"));
  for(const group of Object.values(grouped))assert.deepEqual(group.map(link=>link.order),group.map(link=>link.order).sort((a,b)=>a-b));
});

test("scope, disabled, record href, explicit override and create permission are independent checks",()=>{
  const groups=companyOverviewShortcuts([
    entry(fromKey("company.items"),{href:"/companies/9/items"}),
    entry(fromKey("company.purchases"),{enabled:false}),
    entry(fromKey("company.accounts"),{visible:false}),
    entry(fromKey("company.approved-devices"),{actionAccess:{...actions,view:false}}),
    entry(fromKey("company.item-new"),{actionAccess:{...actions,create:false}}),
    entry(fromKey("company.item-card"),{href:"/companies/2/items/12"}),
    entry(fromKey("public.pages"),{showOnCompanyOverview:false}),
    entry(fromKey("company.pages")),
    entry(fromKey("company.purchase-new"),{navigation:false}),
  ],companyId,false);
  assert.deepEqual(Object.values(groups).flat().map(link=>[link.key,link.action]),[["company.purchase-new","create"]]);
});

test("attendance/actions and fixed company directory remain between cards; toggle is separate",async()=>{
  const source=await readFile(new URL("../apps/web/src/pages/CompanyPages.tsx",import.meta.url),"utf8");
  const card=source.indexOf('shortcutCard("accounts"'),attendance=source.indexOf("<AttendancePunchControls",card),
    newGroup=source.indexOf('shortcutCard("operations"',attendance),admin=source.indexOf('shortcutCard("administration"',newGroup);
  assert.ok(card>=0&&card<attendance&&attendance<newGroup&&newGroup<admin);
  assert.match(source.slice(attendance,newGroup),/extraActions=\{<QuickArchiveUpload \/>\}/);
  assert.match(source.slice(attendance,newGroup),/showPageDirectoryLink=.*directory\.data\?\.some/s);
  const catalog=await readFile(new URL("../apps/web/src/pages/PageDirectoryPage.tsx",import.meta.url),"utf8");
  const shared=await readFile(new URL("../apps/web/src/company-overview-visibility.tsx",import.meta.url),"utf8");
  assert.match(shared,/overview-visibility/);
  assert.match(shared,/entry\.key==="company\.pages" \? <span[^>]*>رابط ثابت/);
  assert.match(catalog,/cell:\(\{row\}\)=>overviewControl\(row\.original\)/);
  assert.match(catalog,/Card title="الظهور في واجهة الشركة"[\s\S]*overviewControl\(entry\)/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { CompanyContext,PageEntry } from "../packages/contracts/src/index.ts";
import { canEditInvoiceItemComposition,exactInvoiceItemCompositionId } from "../apps/web/src/invoice-item-composition-access.ts";

test("the composition menu requires item management and exact composition-card page edit and view",()=>{
  const page={
    key:"company.item-compositions",enabled:true,actionAccess:{view:true,edit:true},
  } as PageEntry;
  const edit={general:false,permissions:["items.manage"]} as CompanyContext;
  const view={general:false,permissions:["items.view"]} as CompanyContext;
  const owner={general:true,permissions:[]} as unknown as CompanyContext;
  assert.equal(canEditInvoiceItemComposition(edit,[page]),true);
  assert.equal(canEditInvoiceItemComposition(owner,[page]),true);
  assert.equal(canEditInvoiceItemComposition(view,[page]),false);
  assert.equal(canEditInvoiceItemComposition(edit,[]),false);
  assert.equal(canEditInvoiceItemComposition(edit,[{...page,enabled:false}]),false);
  assert.equal(canEditInvoiceItemComposition(edit,[{...page,actionAccess:{...page.actionAccess,edit:false}}]),false);
  assert.equal(canEditInvoiceItemComposition(edit,[{...page,actionAccess:{...page.actionAccess,view:false}}]),false);
});
test("only the selected company's exact current item can supply a linked composition",()=>{
  const item={companyId:2,id:18,compositionId:22};
  assert.equal(exactInvoiceItemCompositionId(item,2,18),22);
  assert.equal(exactInvoiceItemCompositionId(item,1,18),null);
  assert.equal(exactInvoiceItemCompositionId(item,2,19),null);
  assert.equal(exactInvoiceItemCompositionId({...item,compositionId:null},2,18),null);
  assert.equal(exactInvoiceItemCompositionId({...item,compositionId:-1},2,18),null);
  assert.equal(exactInvoiceItemCompositionId(undefined,2,18),null);
});
test("invoice composition sheet is placed outside the sale form, and menu option is optional",async()=>{
  const invoice=await readFile(new URL("../apps/web/src/pages/CommercePages.tsx",import.meta.url),"utf8");
  const saleForm=invoice.indexOf('className="commerce-editor"');
  const formEnd=invoice.indexOf("</form>",saleForm);
  const sheet=invoice.indexOf("<InvoiceItemCompositionEditor");
  assert.ok(saleForm>=0&&formEnd>saleForm&&sheet>formEnd);
  assert.match(invoice,/<InvoiceItemCompositionActions[\s\S]*?allowCompositionEdit=\{kind==="sale"&&canEditComposition\}/);
  const menu=await readFile(new URL("../apps/web/src/InvoiceItemActionsDropdown.tsx",import.meta.url),"utf8");
  assert.match(menu,/action==="edit"&&onEditComposition&&<button/);
});

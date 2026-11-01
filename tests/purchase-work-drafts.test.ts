import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const invoice=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
const persistence=readFileSync("apps/web/src/purchase-drafts.ts","utf8");
const css=readFileSync("apps/web/src/styles.css","utf8");

test("purchase work drafts have separate durable IndexedDB data with scoped owners",()=>{
  assert.match(persistence,/alraesy-purchase-work-drafts-v1/);
  assert.match(persistence,/createIndex\("owner", \["userId","companyId"\]\)/);
  assert.match(persistence,/getAll\(\[userId,companyId\]\)/);
  assert.match(persistence,/rows\.some\(row=>row\.id===id\)/);
  assert.match(persistence,/store\.put\(draft\)/);
  assert.match(persistence,/store\.delete\(id\)/);
  assert.doesNotMatch(persistence,/queueOfflineOperation|\/invoices|invoiceSchema|finance\.post|journal/);
});

test("purchase form restores all header fields and all lines, allows several saved drafts",()=>{
  for(const field of ["documentDate","account","supplier","supplierReceiptNumber","currency","branch","location","original","description","discount"]){
    assert.match(invoice,new RegExp("set"+field.charAt(0).toUpperCase()+field.slice(1)+"\\(form\\."+field+"\\)"));
  }
  assert.match(invoice,/setLines\(form\.lines\.length \? form\.lines : \[emptyLine\(\)\]\)/);
  assert.match(invoice,/listPurchaseWorkDrafts<PurchaseDraftForm>/);
  assert.match(invoice,/activePurchaseDraftId \?\? undefined/);
  assert.match(invoice,/resetInvoiceValues\(\);\s*setDraftNotice\("تم الحفظ الأولي وتصفير الفاتورة\."\)/);
  assert.match(invoice,/setActivePurchaseDraftId\(draft\.id\)/);
  assert.match(invoice,/setLastSavedFingerprint\(JSON\.stringify\(form\)\)/);
  assert.match(invoice,/setDraftListOpen/);
  assert.match(invoice,/فتح ومواصلة/);
  assert.match(invoice,/حفظ أولي/);
  assert.match(invoice,/قائمة الفواتير/);
  assert.match(invoice,/تم حذف المسودة المؤقتة فقط/);
  assert.match(invoice,/if \(kind === "purchase" && activePurchaseDraftId\)/);
  assert.match(invoice,/void deletePurchaseWorkDraft\(user\.id, companyId, activePurchaseDraftId\)/);
});

test("multirow purchase navigations offer local save; single row confirms leaving",()=>{
  assert.match(invoice,/status\.dirty && status\.itemCount > 1/);
  assert.match(invoice,/onRegisterDraftSaver=\{registerDraftSaver\}/);
  assert.match(invoice,/for \(const id of points\)/);
  assert.match(invoice,/await save\(\)/);
  assert.match(invoice,/حفظ مؤقت ثم الخروج/);
  assert.match(invoice,/يوجد صنف واحد في فاتورة المشتريات/);
  assert.match(invoice,/حفظها مؤقتًا قبل إغلاق النقطة/);
  assert.match(invoice,/draftFingerprint !== lastSavedFingerprint/);
  assert.match(invoice,/editorDirty && !saving && !unknown/);
  assert.match(invoice,/onStatusChange\(tabId, \{ dirty: editorDirty/);
});

test("purchase draft choices are in the existing Actions drop-down; list opens in a dialog above the invoice",()=>{
  assert.match(invoice,/import \{ SalesHeaderActionsDropdown, PageActionsDropdown \}/);
  assert.match(invoice,/<PageActionsDropdown actions=\{\[/);
  assert.match(invoice,/label: "قائمة الفواتير", to: listPath\(companyId, kind\)/);
  assert.match(invoice,/label: draftSaving \? "جارٍ الحفظ الأولي…"/);
  assert.match(invoice,/label: `المسودات المحفوظة \(\$\{purchaseDrafts\.length\}\)`/);
  assert.match(invoice,/onClick: \(\) => \{ setDraftListOpen\(true\); \}/);
  assert.match(invoice,/<Dialog\s+open=\{draftListOpen\}/);
  assert.match(invoice,/purchaseDrafts\.map\(draft => <div className="purchase-work-draft"/);
  assert.match(invoice,/void openPurchaseDraft\(draft\)/);
  assert.match(invoice,/void removePurchaseDraft\(draft\)/);
  assert.match(invoice,/\{kind === "purchase" && <Dialog/);
  assert.match(css,/\.purchase-work-drafts-list \{/);
  assert.doesNotMatch(invoice,/<section className="purchase-work-drafts"/);
  assert.doesNotMatch(invoice,/الحفظ الأولي مسودة على هذا الجهاز فقط، وليس فاتورة مرحّلة ولا حركة مخزون/);
});

test("temporary save resets only after the IndexedDB write resolves",()=>{
  const save = invoice.slice(invoice.indexOf('async function savePurchaseTemporarily()'),
    invoice.indexOf('async function openPurchaseDraft('));
  assert.match(save,/await savePurchaseWorkDraft\(/);
  assert.match(save,/if \(!guard\.isCurrent\(\)\) return false;/);
  assert.match(save,/resetInvoiceValues\(\)/);
  assert.ok(save.indexOf('await savePurchaseWorkDraft(') < save.indexOf('resetInvoiceValues()'));
  assert.match(save,/catch \(reason\)/);
  assert.doesNotMatch(save,/setActivePurchaseDraftId\(saved\.id\)/);
  assert.match(invoice,/function resetInvoiceValues\(\)/);
  assert.match(invoice,/setLines\(\[first\]\)/);
  assert.match(invoice,/setSupplier\(null\)/);
  assert.match(invoice,/setDiscount\("0"\)/);
  assert.match(invoice,/setActivePurchaseDraftId\(null\)/);
});

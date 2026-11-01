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
  for(const field of ["documentDate","account","supplier","supplierReceiptNumber","currency","branch","location","original","description","discount","lines"]){
    assert.match(invoice,new RegExp("set"+field.charAt(0).toUpperCase()+field.slice(1)+"\\(form\\."+field+"\\)"));
  }
  assert.match(invoice,/listPurchaseWorkDrafts<PurchaseDraftForm>/);
  assert.match(invoice,/activePurchaseDraftId \?\? undefined/);
  assert.match(invoice,/setActivePurchaseDraftId\(saved\.id\)/);
  assert.match(invoice,/setLastSavedFingerprint\(signature\)/);
  assert.match(invoice,/setDraftListOpen/);
  assert.match(invoice,/فتح ومواصلة/);
  assert.match(invoice,/حفظ أولي/);
  assert.match(invoice,/فاتورة جديدة/);
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

test("draft controls and list never appear on sales or printing",()=>{
  assert.match(invoice,/\{kind === "purchase" && <section className="purchase-work-drafts"/);
  assert.match(css,/@media print \{ \.purchase-work-drafts \{ display: none !important; \} \}/);
  assert.match(invoice,/الحفظ الأولي مسودة على هذا الجهاز فقط/);
});

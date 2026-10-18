import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { memoCreateSchema } from "../packages/contracts/src/index.ts";
import {
  InvoiceItemActionsDropdown,
  invoiceItemActionLabels,
} from "../apps/web/src/InvoiceItemActionsDropdown.tsx";

test("sales and purchases share one item action dropdown with three commands", () => {
  assert.deepEqual(Object.values(invoiceItemActionLabels), [
    "تعديل كرت الصنف",
    "تسوية الصنف",
    "إرسال تقرير مرتبط بالصنف",
  ]);
  const html=renderToStaticMarkup(
    <InvoiceItemActionsDropdown itemName="محلول ملح 500 مل"
      disabled={false} canEdit canAdjust canReport onAction={()=>{}}/>,
  );
  assert.match(html,/aria-haspopup="menu"/);
  assert.match(html,/خيارات الصنف/);
  assert.doesNotMatch(html,/type="submit"/);
});

test("linked item report stays a valid review memo with a prefilled item reference", () => {
  const report=memoCreateSchema.safeParse({
    title:"تقرير عن الصنف: محلول ملح",
    body:"ملاحظة فحص الصنف",
    type:"review",
    recipientEmployeeId:17,
    links:{followPage:null,referencePage:null,itemId:128,accountId:null},
    followers:[],options:[],
    idempotencyKey:"10000000-0000-4000-8000-000000000001",
  });
  assert.equal(report.success,true);
  if(report.success)assert.equal(report.data.links?.itemId,128);
});

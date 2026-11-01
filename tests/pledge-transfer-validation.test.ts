import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pledgeCashTransferSchema } from "../apps/api/src/routes-pledges.ts";

const request = {
  idempotencyKey:"b7c0ed48-86fe-4f9c-ae7b-25be4c8742d5",
  mode:"pay" as const,
  amount:"1",
  notes:"",
};

test("cashier pledge transfer accepts normal positive integer and decimal amounts", () => {
  for (const amount of ["1","13000","13.5","0.000001","9999999999999999999999.123456"]) {
    const parsed=pledgeCashTransferSchema.safeParse({...request,amount});
    assert.equal(parsed.success,true,`Rejected valid amount ${amount}: ${parsed.success?"":JSON.stringify(parsed.error.issues)}`);
  }
  assert.equal(pledgeCashTransferSchema.safeParse({...request,mode:"receive",amount:"13000"}).success,true);
});

test("pledge amount does not accept empty input, letters, negative amounts or excessive precision",()=>{
  for(const amount of ["","abc","-1","1.1234567","1,000"]) {
    const parsed=pledgeCashTransferSchema.safeParse({...request,amount});
    assert.equal(parsed.success,false,`Unexpectedly accepted ${amount}`);
  }
});
test("pledge transfer is restricted to one of two operations and valid UUID",()=>{
  assert.equal(pledgeCashTransferSchema.safeParse({...request,mode:"withdraw"}).success,false);
  assert.equal(pledgeCashTransferSchema.safeParse({...request,idempotencyKey:"bad"}).success,false);
});
test("doctor and agency remain invoice data but are absent from printed receipt only",()=>{
  const print=readFileSync("apps/web/src/InvoicePrintSheet.tsx","utf8");
  const editor=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  const schema=readFileSync("packages/contracts/src/commerce.ts","utf8");
  assert.doesNotMatch(print,/doctorName|الطبيب \/ الجهة/);
  assert.match(editor,/doctorName/);
  assert.match(schema,/doctorId: id\.nullable\(\)/);
});

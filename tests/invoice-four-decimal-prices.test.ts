import assert from "node:assert/strict";
import test from "node:test";
import {calculateInvoiceTotals,invoiceLineGross} from "../packages/contracts/src/commerce.ts";
test("four-decimal price rounds the product, not the unit price",()=>{
 assert.equal(invoiceLineGross("84","92.857",2),"7799.99");
 assert.equal(invoiceLineGross("84","92.8571",2),"7800");
 assert.equal(invoiceLineGross("-84","92.857",2),"-7799.99");
 assert.equal(invoiceLineGross("1","0.005",2),"0.01");
 assert.equal(invoiceLineGross("-1","0.005",2),"-0.01");
 assert.equal(invoiceLineGross("84","92.8571",4),"7799.9964");
 assert.throws(()=>invoiceLineGross("84","92.85711",2));
 assert.equal(calculateInvoiceTotals([{quantity:"84",unitPrice:"92.857"}],"0",2).total,"7799.99");
 assert.equal(calculateInvoiceTotals([{quantity:"-84",unitPrice:"92.857"}],"-1",2).total,"-7798.99");
});

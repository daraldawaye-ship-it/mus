import assert from "node:assert/strict";
import test from "node:test";
import {assertLegacy127Scope} from "../apps/api/src/services/legacy-sales-127-repair.ts";
const s={companyId:2,sourceSystem:"dar-aldawa-legacy-2026-10",importDayUtc:"2026-10-30",importedInvoices:127,sales:126,purchasesUnchanged:1,saleLines:560,corrected:0,remaining:126};
test("batch count and kind must match the recorded 127",()=>{assert.doesNotThrow(()=>assertLegacy127Scope(s));assert.throws(()=>assertLegacy127Scope({...s,sales:127}));assert.throws(()=>assertLegacy127Scope({...s,saleLines:561}));assert.doesNotThrow(()=>assertLegacy127Scope({...s,corrected:126,remaining:0}));});

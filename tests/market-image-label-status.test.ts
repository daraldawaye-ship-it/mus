import assert from "node:assert/strict";
import {test} from "node:test";
import {marketImageLabelBatchSchema} from "../apps/api/src/market-image-labels.ts";
test("visual review can be recorded without fabricating a transcription",()=>{
 const entry={position:8,filename:"الصنف.webp",reviewStatus:"مراجعة بصرية — غير محسومة"};
 assert.deepEqual(marketImageLabelBatchSchema.parse({entries:[entry]}),{entries:[entry]});
 assert.equal(marketImageLabelBatchSchema.safeParse({entries:[{...entry,reviewStatus:"ربط الصنف"}]}).success,false);
 assert.equal(marketImageLabelBatchSchema.safeParse({entries:[{...entry,marketCardId:77}]}).success,false);
});

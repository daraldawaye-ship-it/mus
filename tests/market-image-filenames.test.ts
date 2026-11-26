import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFilenameBatchSchema, imageFilenameColumns } from "../apps/api/src/routes-market-staging.ts";
const valid={archiveName:"صور المسار 6.zip",archiveDriveId:"drive_file6",
  entries:[{filename:"دواء - 1.webp",sourceArabicName:"دواء"},{filename:"folder/untitled.png"}]};
test("staging accepts exact filenames and optional titles only",()=>{
  assert.deepEqual(imageFilenameBatchSchema.parse(valid),valid);
  assert.equal(imageFilenameColumns.length,6);
  assert.equal(imageFilenameBatchSchema.safeParse({...valid,entries:[{...valid.entries[0],marketId:123}]}).success,false);
  assert.equal(imageFilenameBatchSchema.safeParse({...valid,entries:[{filename:"index.csv"}]}).success,false);
  assert.equal(imageFilenameBatchSchema.safeParse({...valid,entries:[valid.entries[0],valid.entries[0]]}).success,false);
});

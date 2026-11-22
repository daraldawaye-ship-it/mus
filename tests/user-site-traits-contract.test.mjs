import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { transform } from "esbuild";

test("traits remain an independent owner editor and use a strict revisioned contract", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const file = await read("packages/contracts/src/user-site-traits.ts");
  const {code} = await transform(file, {loader:"ts",format:"esm"});
  const zod = import.meta.resolve("zod");
  const schemas = await import("data:text/javascript;base64," + Buffer.from(code.replace('"zod"', JSON.stringify(zod))).toString("base64"));
  assert.deepEqual(Object.values(schemas.userSiteTraitLabels), ["اداري1","موظف في شركه","محرر","مشرف في السوق","عضو","مسموح في الدردشه","مانح صلاحيات الدردشة","طفل","مسموح في القضايا","معتمد","معروف شخصيا"]);
  const patch = schemas.userSiteTraitsPatchSchema;
  for (const traits of [[],["member"],[...schemas.userSiteTraits]]) assert.equal(patch.safeParse({traits,expectedRevision:1}).success,true);
  for (const input of [
    {traits:["member","member"],expectedRevision:1}, {traits:["owner"],expectedRevision:1},
    {traits:["member"],revision:1}, {traits:["member"],expectedRevision:1,kind:"admin"},
  ]) assert.equal(patch.safeParse(input).success,false);
  const page = await read("apps/web/src/pages/PublicPages.tsx");
  const editor = await read("apps/web/src/pages/UserSiteTraitsEditor.tsx");
  assert.match(page, /user\?\.owner && !employeePreview && !editTarget\.owner && <UserSiteTraitsEditor key=/);
  assert.match(editor, /expectedRevision: loaded\.revision/);
  assert.match(editor, /signal: controller\.signal/);
  await transform(page, {loader:"tsx"});
  await transform(editor, {loader:"tsx"});
});

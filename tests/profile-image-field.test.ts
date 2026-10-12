import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileImageUrlField } from "../apps/web/src/ProfileImageUrlField.tsx";
import { profileSchema } from "../packages/contracts/src/index.ts";

const uploaded = "/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/full";

test("profile form permits a previously uploaded internal image reference", () => {
  const html = renderToStaticMarkup(createElement(ProfileImageUrlField, {
    value: uploaded,
    onChange: () => undefined,
  }));
  assert.match(html, /name="image"/);
  assert.match(html, /type="text"/);
  assert.match(html, /value="\/api\/media\//);
  assert.doesNotMatch(html, /type="url"/);
});

test("profile server validation still permits only internal images or HTTPS", () => {
  const profile = { name: "مستخدم", displayName: "مستخدم", email: "user@example.com", phone: "" };
  assert.equal(profileSchema.safeParse({ ...profile, image: uploaded }).success, true);
  assert.equal(profileSchema.safeParse({ ...profile, image: "https://example.com/image.png" }).success, true);
  assert.equal(profileSchema.safeParse({ ...profile, image: "" }).success, true);
  assert.equal(profileSchema.safeParse({ ...profile, image: "http://example.com/image.png" }).success, false);
  assert.equal(profileSchema.safeParse({ ...profile, image: "/another/insecure/path" }).success, false);
});

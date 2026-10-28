import test from "node:test";
import assert from "node:assert/strict";
import {
  doctorInputSchema,
  doctorPatchSchema,
} from "../packages/contracts/src/doctors.ts";

const draft = {
  name: "طبيب جديد",
  kind: "doctor" as const,
  department: "",
  phone: "",
  searchKeys: "",
  notes: "",
  active: true,
};

test("new manual cards still require a classification", () => {
  assert.equal(doctorInputSchema.safeParse({ ...draft, kind: null }).success, false);
});

test("existing auto-created doctor cards can remain unclassified until review", () => {
  const card = doctorPatchSchema.parse({ ...draft, kind: null, revision: 1 });
  assert.equal(card.kind, null);
});

test("reviewers can classify or archive an existing card", () => {
  assert.equal(doctorPatchSchema.parse({ ...draft, kind: "entity", revision: 1 }).kind, "entity");
  const archived = doctorPatchSchema.parse({ ...draft, kind: null, active: false, revision: 2 });
  assert.equal(archived.active, false);
});

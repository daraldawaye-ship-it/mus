import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Request, Response, RequestHandler } from "express";
import type { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { ZodError } from "zod";
import type { User } from "../packages/contracts/src/index.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { explanationRoutes } from "../apps/api/src/routes-explanations.ts";

// PGlite executes PostgreSQL SQL in an isolated database. Its single connection
// requires transaction serialization, including requests started in parallel.
function poolAdapter(db: PGlite) {
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  return {
    async query(sql: string, values?: unknown[]) {
      const release = await acquire();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() { const release = await acquire(); return { query, release }; },
  } as unknown as Pool;
}

const owner = { id: 1, owner: true, kind: "admin", suspended: false, archived: false } as User;
const member = { ...owner, id: 2, owner: false, kind: "member" } as User;
const fields = {
  title: "Guide", body: "Original", evidence: "Keep evidence", kind: "heading",
  color: "#123ABC", fontSize: 22,
  readAcl: { users: [2], kinds: [] }, editAcl: { users: [1], kinds: [] },
};
type ApiResult = { status: number; payload: Record<string, any> };

test("explanation edits reject stale tokens, preserve metadata, and advance millisecond tokens", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("CREATE TABLE users (id int PRIMARY KEY); INSERT INTO users VALUES (1),(2);");
  await db.exec(await readFile(new URL("../apps/api/migrations/123_explanations.sql", import.meta.url), "utf8"));
  await db.exec("ALTER TABLE explanation_assets ADD COLUMN display_name varchar(250);");
  const group = await db.query<{ id: number }>(
    "INSERT INTO explanation_groups(slug,title,created_by) VALUES ('site-developer-guide','Guides',1) RETURNING id",
  );
  const groupId = group.rows[0].id;
  // PostgreSQL can hold microseconds that HTTP/JavaScript Date values omit.
  // A future timestamp also exercises monotonic increments independent of clock speed.
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO explanation_nodes(group_id,position,kind,title,body,evidence,color,font_size,read_acl,edit_acl,created_by,updated_by,updated_at)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,1,1,'2099-11-21T00:00:00.123456Z') RETURNING id`,
    [groupId, fields.kind, fields.title, fields.body, fields.evidence, fields.color, fields.fontSize,
      JSON.stringify(fields.readAcl), JSON.stringify(fields.editAcl)],
  );
  const nodeId = inserted.rows[0].id;
  const router = explanationRoutes(poolAdapter(db));
  const invoke = (method: "get" | "patch" | "post", path: string, body: unknown = {}, user = owner, id = nodeId) => {
    const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
    assert(route?.route, `${method} ${path}`);
    const handler = route.route.stack[0].handle as RequestHandler;
    return new Promise<ApiResult>((resolve, reject) => {
      const req = { params: { nodeId: String(id) }, body, auth: { user, csrf: "", tokenHash: "" } } as unknown as Request;
      let status = 200;
      const res = {
        status(value: number) { status = value; return res; },
        json(payload: Record<string, unknown>) { resolve({ status, payload: JSON.parse(JSON.stringify(payload)) }); },
      } as unknown as Response;
      handler(req, res, error => {
        if (error instanceof HttpError) resolve({ status: error.status, payload: { code: error.code } });
        else if (error instanceof ZodError) resolve({ status: 400, payload: { code: "validation" } });
        else reject(error);
      });
    });
  };
  const path = "/explanations/nodes/:nodeId";
  const read = async () => (await invoke("get", path)).payload.record;
  const update = (body: unknown, user = owner) => invoke("patch", path, body, user);
  const before = await read();
  assert.equal(before.updatedAt, "2099-11-21T00:00:00.123Z");
  assert.equal((await update({ ...fields, body: "Missing token" })).status, 400);
  assert.equal((await update({ ...fields, expectedUpdatedAt: "invalid" })).status, 400);
  assert.equal((await update({ ...fields, expectedUpdatedAt: before.updatedAt }, member)).status, 403);
  assert.deepEqual(await read(), before, "failed validation and permissions must leave the record intact");

  const first = await update({ ...fields, body: "First edit", expectedUpdatedAt: "2099-11-21T03:00:00.123+03:00" });
  assert.equal(first.status, 200);
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.updatedAt, "2099-11-21T00:00:00.124Z");
  const afterFirst = await read();
  assert.equal(afterFirst.body, "First edit");
  assert.equal(afterFirst.updatedAt, first.payload.updatedAt);
  for (const key of ["title", "evidence", "kind", "color", "fontSize", "readAcl", "editAcl"])
    assert.deepEqual(afterFirst[key], before[key], key);
  assert.deepEqual(await update({ ...fields, body: "Lost overwrite", readAcl: null, editAcl: null,
    fontSize: 10, expectedUpdatedAt: before.updatedAt }), {
    status: 409, payload: { code: "explanation_conflict" },
  });
  assert.deepEqual(await read(), afterFirst, "a stale writer cannot overwrite content or ACLs");

  const simultaneous = await Promise.all(["Writer A", "Writer B"].map(body =>
    update({ ...fields, body, expectedUpdatedAt: afterFirst.updatedAt }),
  ));
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
  const winner = simultaneous.findIndex(result => result.status === 200);
  const afterParallel = await read();
  assert.equal(afterParallel.body, winner === 0 ? "Writer A" : "Writer B");
  assert.equal(afterParallel.updatedAt, "2099-11-21T00:00:00.125Z");
  const next = await update({ ...fields, body: "Next edit", expectedUpdatedAt: afterParallel.updatedAt });
  assert.equal(next.status, 200);
  assert.equal(next.payload.updatedAt, "2099-11-21T00:00:00.126Z");

  // A created record immediately supplies a usable edit token; clients can retry
  // later attachment steps without creating a duplicate record.
  const created = await invoke("post", "/explanations/nodes", { ...fields, groupId, body: "Created" });
  assert.equal(created.status, 201);
  assert.equal(typeof created.payload.updatedAt, "string");
  const newEdit = await invoke("patch", path, {
    ...fields, body: "Created then edited", expectedUpdatedAt: created.payload.updatedAt,
  }, owner, created.payload.id);
  assert.equal(newEdit.status, 200);
  assert.notEqual(newEdit.payload.updatedAt, created.payload.updatedAt);
});

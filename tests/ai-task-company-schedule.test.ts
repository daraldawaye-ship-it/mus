import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response, RequestHandler } from "express";
import type { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { ZodError } from "zod";
import { HttpError } from "../apps/api/src/errors.ts";
import { aiTaskRoutes } from "../apps/api/src/routes-ai-tasks.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { userDTO } from "../apps/api/src/repositories/models.ts";

test("AI task company schedule preserves task identity, privacy, and optimistic concurrency", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users (id int PRIMARY KEY, owner bool, archived bool, suspended bool, created_at timestamptz DEFAULT now());
    INSERT INTO users (id,owner,archived,suspended) VALUES (1,true,false,false),(3,false,false,false),(4,true,false,true);
    CREATE TABLE companies (id int PRIMARY KEY, name text);
    INSERT INTO companies VALUES (2,'دار الدواء');
    CREATE TABLE general_table (general_table_id int PRIMARY KEY, general_table_table_name text,
      general_table_category text, updated_at timestamptz NOT NULL, general_table_description text,
      created_at timestamptz NOT NULL DEFAULT '2026-11-08T01:02:03Z');
    CREATE TABLE ai_tasks (task_id int PRIMARY KEY, section text, company_id int REFERENCES companies,
      cadence_hours int, cadence_label text, private_title text, private_description text, archived_at timestamptz);
    CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,
      target_type text,target_id int,before_value jsonb,after_value jsonb);
    INSERT INTO general_table VALUES
      (434,'مهام الذكاء الاصطناعي','مهامك','2026-11-20T00:00:00Z','keep description'),
      (435,'معرفات المهام الشخصية','','2026-11-20T00:00:00Z',''),
      (436,'مهام الذكاء الاصطناعي','مهامك — مؤرشفة','2026-11-20T00:00:00Z','');
    INSERT INTO ai_tasks VALUES
      (434,'مهامك',NULL,NULL,'معلّقة',NULL,NULL,NULL),
      (435,'مهمة خاصة بمصطفى',NULL,8,NULL,'private','private',NULL),
      (436,'مهامك',NULL,8,NULL,NULL,NULL,now());
  `);
  const query = async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const router = aiTaskRoutes({ connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const operation = "PATCH /ai-tasks/:id/company-schedule";
  const result = apiCatalog(router, { operation });
  assert.equal(result.operations[0]?.operation, operation);
  assert.match(JSON.stringify(result), /expectedUpdatedAt/);
  const route = router.stack.find(layer => layer.route?.path === "/ai-tasks/:id/company-schedule");
  assert(route?.route);
  const handler = route.route.stack[0].handle as RequestHandler;
  const input = { companyId: 2, cadenceHours: 8, expectedUpdatedAt: "2026-11-20T00:00:00Z" };
  const update = (id: number, body = input, user = 1) =>
    new Promise<{ status: number; payload?: Record<string, unknown> }>((resolve, reject) => {
      const req = { params: { id: String(id) }, body, auth: {
        user: userDTO({ id: user, owner: user !== 3, created_at: new Date() }), csrf: "", tokenHash: "",
      } } as unknown as Request;
      const res = { json(payload: Record<string, unknown>) { resolve({ status: 200, payload }); } } as unknown as Response;
      handler(req, res, error => {
        if (error instanceof HttpError) resolve({ status: error.status });
        else if (error instanceof ZodError) resolve({ status: 400 });
        else reject(error);
      });
    });
  assert.equal((await update(434, input, 3)).status, 403);
  assert.equal((await update(434, input, 4)).status, 403);
  assert.equal((await update(435)).status, 404);
  assert.equal((await update(436)).status, 409);
  assert.equal((await update(434, { ...input, companyId: 999 })).status, 404);
  assert.equal((await update(434, { ...input, cadenceHours: 0 })).status, 400);
  const response = await update(434);
  const changed = response.payload;
  assert(changed);
  assert.equal(response.status, 200, JSON.stringify(changed));
  assert.equal(changed.id, 434);
  assert.equal(changed.companyId, 2);
  assert.equal(changed.cadenceHours, 8);
  assert.equal(changed.cadenceLabel, null);
  assert.equal(changed.section, "الشركة");
  assert.equal((await update(434)).status, 409);
  assert.equal((await update(434, { ...input, expectedUpdatedAt: String(changed.updatedAt) })).status, 200);
  const state = await query(`SELECT t.company_id,t.cadence_hours,g.general_table_category,g.general_table_description
     FROM ai_tasks t JOIN general_table g ON g.general_table_id=t.task_id WHERE t.task_id=434`);
  assert.deepEqual(state.rows, [{ company_id: 2, cadence_hours: 8, general_table_category: "الشركة",
    general_table_description: "keep description" }]);
  assert.equal((await query("SELECT target_id FROM audit_events")).rows.length, 1);
});

import { Router } from "express";
import { z } from "zod";
import type { Pool, QueryResultRow } from "pg";
import {
  generalTableSchema,
  type GeneralTableInput,
  type GeneralTableRecord,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, publicAdmin } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { missing, HttpError } from "./errors.ts";

const columns: Record<keyof GeneralTableInput, string> = {
  tableName: "general_table_table_name",
  category: "general_table_category",
  title: "general_table_title",
  description: "general_table_description",
  number1: "general_table_number1",
  number2: "general_table_number2",
  date1: "general_table_date1",
  date2: "general_table_date2",
  text1: "general_table_text1",
  text2: "general_table_text2",
  text3: "general_table_text3",
  text4: "general_table_text4",
  text5: "general_table_text5",
  text6: "general_table_text6",
  text7: "general_table_text7",
  text8: "general_table_text8",
  text9: "general_table_text9",
};
const fields = Object.keys(columns) as (keyof GeneralTableInput)[];
const sqlFields = fields.map((field) => columns[field]);
const valuesOf = (input: GeneralTableInput) =>
  fields.map((field) => input[field]);
const dateOf = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function recordDTO(row: QueryResultRow): GeneralTableRecord {
  return {
    id: row.general_table_id,
    tableName: row.general_table_table_name,
    category: row.general_table_category,
    title: row.general_table_title,
    description: row.general_table_description,
    number1: row.general_table_number1 ?? null,
    number2: row.general_table_number2 ?? null,
    date1: dateOf(row.general_table_date1),
    date2: dateOf(row.general_table_date2),
    text1: row.general_table_text1,
    text2: row.general_table_text2,
    text3: row.general_table_text3,
    text4: row.general_table_text4,
    text5: row.general_table_text5,
    text6: row.general_table_text6,
    text7: row.general_table_text7,
    text8: row.general_table_text8,
    text9: row.general_table_text9,
    createdBy: row.created_by,
    createdAt: dateOf(row.created_at)!,
    updatedAt: dateOf(row.updated_at)!,
  };
}
export function generalTableRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/general-table",
    handler(async (req, res) => {
      publicAdmin(actor(req));
      const query = listQuery(
        req.query,
        {
          id: "general_table_id",
          tableName: "general_table_table_name",
          category: "general_table_category",
          title: "general_table_title",
          createdAt: "created_at",
          updatedAt: "updated_at",
        },
        "id:desc",
      );
      const params: unknown[] = [searchPattern(query.q)];
      let where =
        "(general_table_table_name ILIKE $1 OR general_table_category ILIKE $1 OR general_table_title ILIKE $1 OR general_table_description ILIKE $1)";
      for (const [key, column] of [
        ["tableName", "general_table_table_name"],
        ["category", "general_table_category"],
      ] as const) {
        const value = req.query[key];
        if (value === undefined || value === "") continue;
        if (typeof value !== "string" || value.length > 120)
          throw new HttpError(400, "invalid_query", "عامل التصفية غير صالح");
        params.push(value.trim());
        where += ` AND ${column}=$${params.length}`;
      }
      const total = await pool.query(
        `SELECT count(*)::integer AS total FROM general_table WHERE ${where}`,
        params,
      );
      const rows = await pool.query(
        `SELECT * FROM general_table WHERE ${where} ORDER BY ${query.order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.pageSize, query.offset],
      );
      res.json({
        items: rows.rows.map(recordDTO),
        total: total.rows[0].total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
  );
  router.post(
    "/general-table/duplicate",
    handler(async (req, res) => {
      const input = parse(
        z.object({
          ids: z.array(z.number().int().positive().max(2_147_483_647))
            .min(1, "حدد سجلًا واحدًا على الأقل")
            .max(100, "يمكن تكرار 100 سجل في العملية الواحدة")
            .refine((ids) => new Set(ids).size === ids.length, "لا تكرر رقم السجل في الطلب"),
        }).strict(),
        req.body,
      );
      const records = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        publicAdmin(user);
        await assertRequestPagesEnabled(client, req, true);
        // Lock and validate every source record before any insert. The entire
        // copy operation rolls back if a source is missing or auditing fails.
        const source = await client.query(
          "SELECT * FROM general_table WHERE general_table_id=ANY($1::integer[]) FOR SHARE",
          [input.ids],
        );
        const found = new Map(source.rows.map((row) => [row.general_table_id as number, row]));
        if (found.size !== input.ids.length) missing();
        const created: GeneralTableRecord[] = [];
        for (const sourceId of input.ids) {
          const original = recordDTO(found.get(sourceId)!);
          const copy = await client.query(
            `INSERT INTO general_table(${sqlFields.join(",")},created_by)
             SELECT ${sqlFields.join(",")},$1 FROM general_table
             WHERE general_table_id=$2 RETURNING *`,
            [user.id, sourceId],
          );
          const next = recordDTO(copy.rows[0]);
          await audit(
            client, user, "generalTable.duplicate", "generalTable",
            next.id, { sourceId, record: original }, next,
          );
          created.push(next);
        }
        return created;
      });
      res.status(201).json({ created: records.length, records });
    }),
  );
  router.get(
    "/general-table/table-names",
    handler(async (req, res) => {
      publicAdmin(actor(req));
      const query = req.query.q;
      if (query !== undefined && (typeof query !== "string" || query.length > 120))
        throw new HttpError(400, "invalid_query", "اسم الجدول غير صالح");
      const q = typeof query === "string" ? query.trim() : "";
      const rows = await pool.query(
        `SELECT DISTINCT general_table_table_name AS name FROM general_table
         WHERE general_table_table_name<>'' AND general_table_table_name ILIKE $1
         ORDER BY name LIMIT 100`,
        [searchPattern(q)],
      );
      res.json({ items: rows.rows.map(row => row.name as string) });
    }),
  );
  router.get(
    "/general-table/:id",
    handler(async (req, res) => {
      publicAdmin(actor(req));
      const found = await pool.query(
        "SELECT * FROM general_table WHERE general_table_id=$1",
        [id(req.params.id)],
      );
      if (!found.rows[0]) missing();
      res.json({ record: recordDTO(found.rows[0]) });
    }),
  );
  router.post(
    "/general-table",
    handler(async (req, res) => {
      const input = parse(generalTableSchema, req.body);
      const record = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        publicAdmin(user);
        await assertRequestPagesEnabled(client, req, true);
        const placeholders = sqlFields.map((_, i) => `$${i + 1}`).join(",");
        const result = await client.query(
          `INSERT INTO general_table(${sqlFields.join(",")},created_by) VALUES(${placeholders},$${sqlFields.length + 1}) RETURNING *`,
          [...valuesOf(input), user.id],
        );
        const next = recordDTO(result.rows[0]);
        await audit(
          client,
          user,
          "generalTable.create",
          "generalTable",
          next.id,
          null,
          next,
        );
        return next;
      });
      res.status(201).json({ record });
    }),
  );
  router.patch(
    "/general-table/:id",
    handler(async (req, res) => {
      const targetId = id(req.params.id);
      const input = parse(generalTableSchema, req.body);
      const record = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        publicAdmin(user);
        await assertRequestPagesEnabled(client, req, true);
        const found = await client.query(
          "SELECT * FROM general_table WHERE general_table_id=$1 FOR UPDATE",
          [targetId],
        );
        if (!found.rows[0]) missing();
        const before = recordDTO(found.rows[0]);
        const assignments = sqlFields
          .map((field, index) => `${field}=$${index + 1}`)
          .join(",");
        const changed = await client.query(
          `UPDATE general_table SET ${assignments},updated_at=now() WHERE general_table_id=$${sqlFields.length + 1} RETURNING *`,
          [...valuesOf(input), targetId],
        );
        const next = recordDTO(changed.rows[0]);
        await audit(
          client,
          user,
          "generalTable.update",
          "generalTable",
          next.id,
          before,
          next,
        );
        return next;
      });
      res.json({ record });
    }),
  );
  return router;
}

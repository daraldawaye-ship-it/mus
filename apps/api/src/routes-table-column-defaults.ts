import { Router } from "express";
import type { Pool } from "pg";
import {
  tableColumnDefaultIds, tableColumnDefaultsCatalog, tableColumnDefaultsInputSchema,
  tableColumnDefaultsResponseSchema, usableColumnDefaults,
  type TableColumnDefaultId, type TableColumnDefaults,
} from "../../../packages/contracts/src/table-column-defaults.ts";
import { transaction, type Database } from "./db.ts";
import { HttpError, missing } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertDirectoryAccess, assertRequestPagesEnabled, directoryEntries } from "./services/pages.ts";
import { assertItemOptionsListReadAccess } from "./routes-item-options-list.ts";
import { audit } from "./services/audit.ts";

type ColumnScope = { companyId: number; tableId: TableColumnDefaultId };
type SavedRow = { revision: number; columns: unknown };

function readScope(companyId: string | string[] | undefined, tableId: unknown): ColumnScope {
  if (typeof tableId !== "string" || !tableColumnDefaultIds.some(key => key === tableId))
    missing("الجدول غير متاح لإعدادات الأعمدة");
  return { companyId: id(companyId), tableId: tableId as TableColumnDefaultId };
}

function retainedColumns(tableId: TableColumnDefaultId, row: SavedRow): TableColumnDefaults {
  const parsed = tableColumnDefaultsResponseSchema.parse(row);
  return { revision: parsed.revision,
    columns: usableColumnDefaults<string>(tableColumnDefaultsCatalog[tableId].columnIds, parsed.columns) };
}

export async function readTableColumnDefaults(db: Database, { companyId, tableId }: ColumnScope) {
  const result = await db.query<SavedRow>(
    'SELECT revision, columns_json AS columns FROM company_table_column_defaults WHERE company_id=$1 AND table_key=$2',
    [companyId, tableId]);
  return result.rows[0] ? retainedColumns(tableId, result.rows[0]) : { revision: 0, columns: [] };
}

export async function saveTableColumnDefaults(
  db: Database, { companyId, tableId }: ColumnScope, updatedBy: number, input: unknown,
) {
  const { expectedRevision, columns } = parse(tableColumnDefaultsInputSchema, input);
  const safe = usableColumnDefaults<string>(tableColumnDefaultsCatalog[tableId].columnIds, columns);
  if (safe.length !== columns.length)
    throw new HttpError(400, "unknown_table_column", "عمود غير معروف لهذا الجدول");
  if (safe.length === tableColumnDefaultsCatalog[tableId].columnIds.length && safe.every(column => !column.visible))
    throw new HttpError(400, "table_columns_all_hidden", "اترك عمودًا واحدًا على الأقل ظاهرًا");
  const parameters = [companyId, tableId, JSON.stringify(safe.map(column => ({
    ...column, color: column.color?.toLowerCase() ?? null,
  }))), updatedBy];
  const result = expectedRevision === 0
    ? await db.query<SavedRow>(`INSERT INTO company_table_column_defaults
        (company_id, table_key, columns_json, updated_by, revision) VALUES ($1,$2,$3::jsonb,$4,1)
        ON CONFLICT (company_id, table_key) DO NOTHING RETURNING revision, columns_json AS columns`, parameters)
    : await db.query<SavedRow>(`UPDATE company_table_column_defaults
        SET columns_json=$3::jsonb, updated_by=$4, updated_at=clock_timestamp(), revision=revision+1
        WHERE company_id=$1 AND table_key=$2 AND revision=$5 RETURNING revision, columns_json AS columns`,
      [...parameters, expectedRevision]);
  if (!result.rows[0])
    throw new HttpError(409, "table_columns_conflict", "تغيرت إعدادات الأعمدة. أعد تحميلها قبل الحفظ.");
  return retainedColumns(tableId, result.rows[0]);
}

export function tableColumnDefaultsRoutes(pool: Pool): Router {
  const router = Router();
  const path = "/companies/:companyId/table-column-defaults/:tableId";
  router.get(path, handler(async (req, res) => {
    const sessionUser = actor(req);
    const scope = readScope(req.params.companyId, req.params.tableId);
    const result = await transaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(db, sessionUser, false);
      await companyAccess(db, user, scope.companyId, scope.tableId === "journal-lines" ? "finance.view" : "items.view");
      await assertRequestPagesEnabled(db, req);
      if (scope.tableId === "item-options-list")
        await assertItemOptionsListReadAccess(db, user, scope.companyId);
      return readTableColumnDefaults(db, scope);
    });
    res.set("Cache-Control", "private, no-store").json(result);
  }));
  router.put(path, handler(async (req, res) => {
    const sessionUser = actor(req);
    const scope = readScope(req.params.companyId, req.params.tableId);
    const result = await transaction(pool, async db => {
      const user = await currentActor(db, sessionUser);
      ownerOnly(user);
      const entries = await directoryEntries(db, user, scope.companyId);
      const settings = entries.find(entry => entry.key === "company.table-column-defaults");
      const target = entries.find(entry => entry.key === tableColumnDefaultsCatalog[scope.tableId].pageKey);
      if (!settings || !target) missing("الصفحة غير موجودة");
      assertDirectoryAccess(settings, "edit");
      assertDirectoryAccess(target, "view");
      const saved = await saveTableColumnDefaults(db, scope, user.id, req.body);
      await audit(db, user, "page.settings", "companyTableColumnDefaults", null, null,
        { tableKey: scope.tableId, revision: saved.revision }, scope.companyId);
      return saved;
    });
    res.set("Cache-Control", "private, no-store").json(result);
  }));
  return router;
}

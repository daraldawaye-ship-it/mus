import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { itemSaleTimesJoinSql, itemSaleTimesOrderSql } from "../apps/api/src/services/item-sale-ranking.ts";
import { stagedDailyActivitySql } from "../apps/api/src/services/staged-activity-sql.ts";

test("item lookup ranks from daily prepared tables without scanning staged documents", () => {
  assert.match(itemSaleTimesJoinSql, /JOIN staged_item_sale_rankings staged_rank/);
  assert.doesNotMatch(itemSaleTimesJoinSql, /legacy_import_staging|jsonb_array_elements|GROUP BY/i);
  assert.match(itemSaleTimesOrderSql, /staged_rank\.net_sale_invoices/);
});
test("item quantities and frequency read from precomputed daily activity", () => {
  const sql = stagedDailyActivitySql("$3::date");
  assert.match(sql, /staged_item_daily_activity_cache/);
  assert.doesNotMatch(sql, /legacy_import_staging|jsonb_array_elements/);
});
test("source posting removes the read-only cache and sidebar uses a bounded lookup", () => {
  const migration = readFileSync(new URL("../apps/api/migrations/157_staged_invoice_read_cache.sql", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../apps/api/src/routes-commerce.ts", import.meta.url), "utf8");
  assert.match(migration, /AFTER INSERT ON transaction_source_imports/);
  assert.match(migration, /DELETE FROM staged_invoice_item_contributions/);
  assert.match(routes, /staged_invoice_item_lines_cache/);
  assert.match(routes, /ORDER BY document_date DESC,source_id DESC,line_number DESC\s+LIMIT/);
  assert.doesNotMatch(routes.slice(routes.indexOf("item-history/:itemId"), routes.indexOf("invoice-stock-preview")), /jsonb_array_elements/);
});

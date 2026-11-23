import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  itemProfitFactorSchema, itemOrderAlertQuantitySchema, itemSchema,
} from "../packages/contracts/src/items.ts";

test("all existing and newly created items default to factor 1.2 without allowing a factor under 1", () => {
  assert.equal(itemProfitFactorSchema.parse("1.2"), "1.2");
  assert.equal(itemProfitFactorSchema.parse("1"), "1");
  assert.equal(itemProfitFactorSchema.safeParse("0.9").success, false);
  assert.equal(itemProfitFactorSchema.safeParse("0").success, false);
  assert.equal(itemProfitFactorSchema.safeParse("-1").success, false);
  assert.equal(itemProfitFactorSchema.safeParse("1.23456").success, false);
  const migration=readFileSync("apps/api/migrations/20261109_item_profit_order_reminders.sql","utf8");
  assert.match(migration,/default_profit_factor numeric\(10,4\) NOT NULL DEFAULT 1\.2000/);
  assert.match(migration,/default_profit_factor >= 1/);
  assert.equal(itemSchema.shape.defaultProfitFactor._def.type,"default");
});

test("optional order-alert first-unit quantity allows zero but not blank or negative", () => {
  assert.equal(itemOrderAlertQuantitySchema.parse(null), null);
  assert.equal(itemOrderAlertQuantitySchema.parse("0"), "0");
  assert.equal(itemOrderAlertQuantitySchema.parse("١٢"), "12");
  assert.equal(itemOrderAlertQuantitySchema.safeParse("").success, false);
  assert.equal(itemOrderAlertQuantitySchema.safeParse("-1").success, false);
  assert.equal(itemOrderAlertQuantitySchema.safeParse("1.5").success, false);
  const migration=readFileSync("apps/api/migrations/20261109_item_profit_order_reminders.sql","utf8");
  assert.match(migration,/order_alert_quantity numeric\(22,0\)/);
  assert.match(migration,/order_alert_quantity IS NULL OR order_alert_quantity >= 0/);
  assert.match(migration,/ITEM_ORDER_LEVEL/);
  assert.match(migration,/إذا كمية الطلب للأصناف الخاصة/);
});

test("grouped special-order reminders use the exact first-unit threshold without stock returns", () => {
  const monitor = readFileSync("apps/api/src/services/grouped-stock-alerts.ts","utf8");
  const worker = readFileSync("apps/api/src/services/attendance-notifications.ts","utf8");
  const wrapper = readFileSync("apps/api/src/services/item-order-reminders.ts","utf8");
  assert.match(monitor,/stock_showroom,0\)\+COALESCE\(s\.stock_warehouse,0\)/);
  assert.match(monitor,/i\.order_alert_quantity\*i\.factor2::numeric\*i\.factor3::numeric/);
  assert.match(monitor,/i\.order_alert_quantity IS NOT NULL/);
  assert.match(monitor,/subjectKey:"aggregate:"\+code/);
  assert.match(monitor,/stock_alert_group_scans/);
  assert.match(monitor,/minIntervalHours/);
  assert.match(monitor,/stockAlertCheckHours/);
  assert.match(monitor,/item-order-levels\?level=low/);
  assert.match(wrapper,/scanGroupedStockAlert\(client,companyId,"ITEM_ORDER_LEVEL"\)/);
  assert.match(worker,/scanGroupedExpiryAlerts\(client, companyId\)/);
  assert.match(worker,/scanDailyItemOrderReminders\(client, companyId\)/);
});

test("expiry monitors and follow-up reports use item-card nearest expiry and net stock once per item", () => {
  const monitor = readFileSync("apps/api/src/services/grouped-stock-alerts.ts","utf8");
  const route = readFileSync("apps/api/src/routes-expiry-alert-follow-up.ts","utf8");
  for (const source of [monitor,route]) {
    assert.match(source,/i\.nearest_expiry_date/);
    assert.match(source,/i\.active AND i\.has_expiry/);
    assert.match(source,/stats\.stock_showroom,0\)\+COALESCE\(stats\.stock_warehouse,0\)>0/);
    assert.doesNotMatch(source,/s\.batch_key\s*[<>=]/);
    assert.doesNotMatch(source,/b\.batch_key\s*[<>=]/);
  }
  assert.match(monitor,/i\.nearest_expiry_date < clock\.today/);
  assert.match(monitor,/i\.nearest_expiry_date >= clock\.today/);
  assert.match(monitor,/scanGroupedStockAlert\(client,companyId,code\)/);
  assert.match(monitor,/expired-items-follow-up/);
  assert.match(monitor,/expiring-items-follow-up/);
  assert.match(route,/i\.id AS item_id/);
  assert.match(route,/i\.nearest_expiry_date::text AS expiry_date/);
  assert.match(route,/ROUND\(\(COALESCE\(stats\.stock_showroom,0\)/);
});

test("stock balance summary nets opposite-sign lots without changing detail view", () => {
  const server = readFileSync("apps/api/src/routes-inventory.ts","utf8");
  const page = readFileSync("apps/web/src/pages/InventoryPages.tsx","utf8");
  assert.match(server,/stock-balances\/summary/);
  assert.match(server,/SUM\(s\.quantity_smallest\)/);
  assert.match(server,/i\.nearest_expiry_date::text/);
  assert.match(page,/BalancesSummaryList/);
  assert.match(page,/params\.get\("view"\) === "lots"/);
  assert.match(page,/أقرب تاريخ انتهاء \(كرت الصنف\)/);
});

test("order-level notification inbox follows the recipient card's current positions", () => {
  const sql=readFileSync("apps/api/src/services/notifications.ts","utf8");
  assert.match(sql,/n\.code<>'ITEM_ORDER_LEVEL'/);
  assert.match(sql,/selectedEmployee/);
  assert.match(sql,/position_keys/);
});


test("special-item threshold notification ignores stopped order dates; only NULL disables it", () => {
  const scanner=readFileSync("apps/api/src/services/grouped-stock-alerts.ts","utf8");
  const routes=readFileSync("apps/api/src/routes-item-options-list.ts","utf8");
  assert.match(scanner,/i\.order_alert_quantity IS NOT NULL/);
  assert.doesNotMatch(scanner,/order_stopped_until/);
  assert.match(routes,/items\/:itemId\/order-alert-quantity/);
  assert.match(routes,/orderAlertQuantity: itemOrderAlertQuantitySchema/);
  assert.match(routes,/order_alert_quantity=\$3::numeric/);
  assert.match(routes,/items\/:itemId\/order-stop-period/);
  assert.match(routes,/period: z\.enum\(\["ten-years","one-year","four-months","three-days","resume"\]\)/);
  assert.match(routes,/input\.period === "ten-years" \? 120/);
  assert.match(routes,/input\.period === "one-year" \? 12/);
  assert.match(routes,/input\.period === "four-months" \? 4 : 0/);
  assert.match(routes,/input\.period === "three-days" \? 3 : 0/);
  assert.match(routes,/make_interval\(months => \$3::integer, days => \$5::integer\)/);
  assert.match(routes,/\[companyId,itemId,months,input\.revision,days,resume\]/);
  assert.match(routes,/order_stopped_until= CASE WHEN \$6::boolean THEN NULL ELSE/);
  assert.match(routes,/AT TIME ZONE 'Asia\/Aden'/);
  assert.match(routes,/assertDirectoryAccess\(listPage,"edit"\)/);
  assert.match(routes,/revision=revision\+1/);
  assert.match(routes,/order_alert_quantity::text AS "orderAlertQuantity"/);
  assert.match(routes,/order_stopped_until::text AS "orderStoppedUntil"/);
});

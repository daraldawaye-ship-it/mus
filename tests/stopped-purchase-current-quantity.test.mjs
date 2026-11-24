import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { stoppedPurchaseNotificationIsEligible as eligible } from "../apps/api/src/services/stopped-purchase-notification-scope.ts";

test("stored threshold hides only same-company stopped purchase warnings, never rewrites their history", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE items(company_id integer,id integer,order_alert_quantity numeric CHECK(order_alert_quantity>=0),PRIMARY KEY(company_id,id));
      CREATE TABLE notices(id integer,company_id integer,code text,subject_key text,completed_at timestamp);
      INSERT INTO items VALUES (2,1,NULL),(2,2,0),(2,3,60),(3,3,NULL);
      INSERT INTO notices VALUES
        (11,2,'PURCHASE_STOPPED_ORDER','purchase:20:item:1',NULL),
        (12,2,'PURCHASE_STOPPED_ORDER','purchase:20:item:2',NULL),
        (13,2,'PURCHASE_STOPPED_ORDER','purchase:20:item:3',NULL),
        (14,3,'PURCHASE_STOPPED_ORDER','purchase:20:item:3',NULL),
        (15,2,'ITEM_ORDER_LEVEL','purchase:20:item:3',NULL),
        (16,2,'PURCHASE_STOPPED_ORDER','unknown legacy',NULL),
        (17,2,'PURCHASE_STOPPED_ORDER','purchase:20:item:999999999999999999999999999999999',NULL),
        (18,2,'PURCHASE_STOPPED_ORDER','purchase:20:item:3',clock_timestamp());
    `);
    const ids = async extra => (await db.query("SELECT id FROM notices n WHERE " + extra + " ORDER BY id")).rows.map(r=>r.id);
    assert.deepEqual(await ids("n.completed_at IS NULL AND " + eligible), [11,14,15,16,17]);
    assert.deepEqual(await ids("TRUE"), [11,12,13,14,15,16,17,18]);
    await db.exec("UPDATE items SET order_alert_quantity=5 WHERE company_id=2 AND id=1");
    assert.deepEqual(await ids("n.completed_at IS NULL AND " + eligible), [14,15,16,17]);
    assert.deepEqual(await ids("TRUE"), [11,12,13,14,15,16,17,18]);
  } finally { await db.close(); }
});

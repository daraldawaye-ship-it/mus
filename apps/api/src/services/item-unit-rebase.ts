import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { conflict } from "./masters.ts";
import { audit } from "./audit.ts";

type Factors = { factor2: number; factor3: number; unit1Name: string; unit2Name: string; unit3Name: string; hasExpiry: boolean };
export interface UnitRebaseRow { id: number; location_id: number; batch_key: string; quantity_smallest: string }
const capacity = 10n ** 40n;

/** Explicitly converts stored smallest-unit counts while retaining exact first-unit quantity. */
export function planWholeUnitRebase(
  before: Factors,
  next: Factors,
  rows: readonly UnitRebaseRow[],
): Array<UnitRebaseRow & { quantityAfter: string; delta: string }> {
  const oldPack = BigInt(before.factor2) * BigInt(before.factor3);
  const newPack = BigInt(next.factor2) * BigInt(next.factor3);
  if (before.unit1Name !== next.unit1Name || before.hasExpiry !== next.hasExpiry ||
      oldPack === newPack ||
      (next.factor2 > 1 && !next.unit2Name.trim()) ||
      (next.factor3 > 1 && (!next.unit3Name.trim() || next.factor2 <= 1)))
    conflict("تغيير عدد الوحدة يتطلب الحفاظ على الوحدة الأولى ونوع الانتهاء وأسماء الوحدات الفعالة.");
  return rows.map(row => {
    const count = BigInt(row.quantity_smallest);
    if (count % oldPack !== 0n)
      conflict("لا يمكن تحويل الوحدة: في أحد المخازن أو الدفعات كمية ليست عددًا صحيحًا بالوحدة الأولى.");
    const after = count / oldPack * newPack;
    if (after >= capacity || after <= -capacity)
      conflict("لا يمكن تحويل الوحدة: كمية المخزون الجديدة تتجاوز حد قاعدة البيانات.");
    return { ...row, quantityAfter: after.toString(), delta: (after - count).toString() };
  });
}

/**
 * The item row must already be locked FOR UPDATE by routes-items.ts.
 * This and the item UPDATE happen in the SAME transaction, without editing
 * historical stock movements, posted invoices, journal entries or item cost.
 * A zero-cost unit_rebase movement records each difference for reconciliation.
 */
export async function rebaseWholeUnitStock(
  client: PoolClient,
  companyId: number,
  itemId: number,
  user: User,
  before: Factors,
  next: Factors,
): Promise<void> {
  const result = await client.query<UnitRebaseRow>(
    `SELECT id,location_id,batch_key,quantity_smallest::text AS quantity_smallest
      FROM stock_balances WHERE company_id=$1 AND item_id=$2 ORDER BY id FOR UPDATE`,
    [companyId, itemId],
  );
  const plan = planWholeUnitRebase(before, next, result.rows);
  const valuation = await client.query<{ quantity_smallest: string; value_base: string }>(
    `SELECT quantity_smallest::text AS quantity_smallest,value_base::text AS value_base
       FROM stock_item_valuations WHERE company_id=$1 AND item_id=$2 FOR UPDATE`,
    [companyId, itemId],
  );
  const oldTotal = plan.reduce((sum, row) => sum + BigInt(row.quantity_smallest), 0n);
  const newTotal = plan.reduce((sum, row) => sum + BigInt(row.quantityAfter), 0n);
  if (!valuation.rows[0] || BigInt(valuation.rows[0].quantity_smallest) !== oldTotal)
    conflict("تعذر تحويل الوحدة: أرصدة المخزون وتقييمه غير متطابقين؛ راجع البيانات قبل التعديل.");
  if (newTotal >= capacity || newTotal <= -capacity)
    conflict("تعذر تحويل الوحدة: إجمالي الكمية الجديدة يتجاوز الحد المدعوم.");

  const oldPack = BigInt(before.factor2) * BigInt(before.factor3);
  const newPack = BigInt(next.factor2) * BigInt(next.factor3);
  const documentDate = (await client.query<{ date: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
  )).rows[0]!.date;
  const oldSnapshot = {
    unit1Name: before.unit1Name, unit2Name: before.unit2Name, unit3Name: before.unit3Name,
    factor2: before.factor2, factor3: before.factor3,
    quantitySmallest: oldTotal.toString(),
    valueBase: valuation.rows[0].value_base,
  };
  const newSnapshot = {
    unit1Name: next.unit1Name, unit2Name: next.unit2Name, unit3Name: next.unit3Name,
    factor2: next.factor2, factor3: next.factor3,
    quantitySmallest: newTotal.toString(),
    valueBase: valuation.rows[0].value_base,
  };
  const payload = { itemId, before: oldSnapshot, after: newSnapshot,
    batches: plan.map(row => ({ locationId: row.location_id, batchKey: row.batch_key,
      before: row.quantity_smallest, after: row.quantityAfter, delta: row.delta })) };
  const operation = await client.query<{ id: number }>(
    `INSERT INTO stock_operations
       (company_id,kind,document_date,description,created_by,idempotency_key,creation_payload)
       VALUES($1,'unit_rebase',$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [companyId, documentDate,
      `إعادة تعريف وحدات الصنف ${itemId}: ${oldPack.toString()} ← ${newPack.toString()}`,
      user.id, randomUUID(), JSON.stringify(payload)],
  );

  for (const row of plan) {
    if (row.delta === "0") continue;
    await client.query(
      `UPDATE stock_balances SET quantity_smallest=$1,updated_at=clock_timestamp()
       WHERE company_id=$2 AND item_id=$3 AND id=$4`,
      [row.quantityAfter, companyId, itemId, row.id],
    );
    await client.query(
      `INSERT INTO stock_movements
       (company_id,item_id,location_id,batch_key,quantity_smallest,cost_base,kind,document_date,created_by,operation_id)
       VALUES($1,$2,$3,$4,$5,0,'unit_rebase',$6,$7,$8)`,
      [companyId, itemId, row.location_id, row.batch_key, row.delta, documentDate, user.id, operation.rows[0]!.id],
    );
  }
  await client.query(
    `UPDATE stock_item_valuations SET quantity_smallest=$1 WHERE company_id=$2 AND item_id=$3`,
    [newTotal.toString(), companyId, itemId],
  );
  // A transaction-local token is consumed by the DB item trigger. Never
  // disable triggers or set a session-global bypass.
  await client.query("SELECT set_config('alraesy.item_unit_rebase',$1,true)", [
    `${companyId}:${itemId}:${oldPack.toString()}:${newPack.toString()}`,
  ]);
  await audit(client,user,"stock.unit_rebase","stockOperation",operation.rows[0]!.id,oldSnapshot,newSnapshot,companyId);
}

import type { Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Item } from "../../../../packages/contracts/src/index.ts";
import { transaction, type Database } from "../db.ts";
import { actor, id } from "../http.ts";
import { companyAccess, currentActor } from "../policies/access.ts";
import { HttpError } from "../errors.ts";
import { conflict } from "./masters.ts";

export async function readItems<T>(
  pool: Pool,
  req: Request,
  action: (client: PoolClient, companyId: number) => Promise<T>,
): Promise<T> {
  const companyId = id(req.params.companyId);
  return transaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, "items.view");
    return action(client, companyId);
  });
}
export async function itemIdempotent(
  db: Database,
  table: "items" | "item_agents" | "item_compositions",
  companyId: number,
  key: string,
  payload: unknown,
): Promise<QueryResultRow | null> {
  // Old accepted creates may predate these defaults; keep their payload immutable.
  const samePayload = table === "items"
    ? `('{"legacyId":"","defaultSaleUnit":1,"compositionId":null,"shelfId":null}'::jsonb || creation_payload)=('{"legacyId":"","defaultSaleUnit":1,"compositionId":null,"shelfId":null}'::jsonb || $3::jsonb)`
    : "creation_payload=$3::jsonb";
  const result = await db.query(
    `SELECT id,(${samePayload}) AS same_payload FROM ${table} WHERE company_id=$1 AND idempotency_key=$2`,
    [companyId, key, JSON.stringify(payload)],
  );
  if (!result.rows[0]) return null;
  if (!result.rows[0].same_payload)
    conflict(
      "مفتاح العملية مستخدم لبيانات مختلفة؛ أعد إرسال البيانات الأصلية أو ابدأ عملية جديدة",
    );
  return result.rows[0];
}
export async function nextItemCode(
  db: PoolClient,
  companyId: number,
): Promise<string> {
  await db.query(
    "INSERT INTO item_counters(company_id) VALUES($1) ON CONFLICT(company_id) DO NOTHING",
    [companyId],
  );
  const counter = await db.query(
    "UPDATE item_counters SET next_number=next_number+1 WHERE company_id=$1 AND next_number<=99999999 RETURNING next_number-1 AS number",
    [companyId],
  );
  if (!counter.rows[0])
    conflict("نفد مجال ترقيم الأصناف المكون من ثمانية أرقام");
  return counter.rows[0].number.toString().padStart(8, "0");
}
export type ItemFields = Pick<
  Item,
  | "name"
  | "imageId"
  | "englishName"
  | "shelf"
  | "shelfId"
  | "barcode"
  | "legacyId"
  | "agentId"
  | "compositionId"
  | "unit1Name"
  | "unit2Name"
  | "unit3Name"
  | "factor2"
  | "factor3"
  | "defaultSaleUnit"
  | "salePrice1"
  | "salePrice2"
  | "salePrice3"
  | "purchasePrice"
  | "commissionRate"
  | "clearanceFrom"
  | "clearanceTo"
  | "settlementApprovalDate"
  | "settlementDisplayDate"
  | "purchaseFactor"
  | "currencyId"
  | "reorderLimit"
  | "orderQuantity"
  | "searchKeys"
  | "purchaseNotes"
  | "orderStoppedUntil"
  | "hasExpiry"
  | "active"
>;
export async function checkItemReferences(
  db: Database,
  companyId: number,
  input: ItemFields,
  previous: Item | null = null,
): Promise<void> {
  if (
    (input.defaultSaleUnit === 2 && (input.factor2 <= 1 || !input.unit2Name)) ||
    (input.defaultSaleUnit === 3 && (input.factor3 <= 1 || !input.unit3Name))
  )
    throw new HttpError(
      400,
      "inactive_default_sale_unit",
      "اختر وحدة مفعلة كوحدة افتراضية للمبيعات",
    );
  if(input.imageId){
    const image=await db.query("SELECT 1 FROM media_assets WHERE id=$1 AND company_id=$2 AND purpose='item'",[input.imageId,companyId]);
    if(!image.rowCount)conflict("اختر صورة مرفوعة لهذه الشركة فقط");
  }
  if(input.legacyId){
    const duplicate=await db.query("SELECT 1 FROM items WHERE company_id=$1 AND legacy_id=$2 AND id<>$3",[companyId,input.legacyId,previous?.id??0]);
    if(duplicate.rowCount)conflict("المعرف في النظام السابق مستخدم لصنف آخر في هذه الشركة");
  }
  const reactivated = previous !== null && !previous.active && input.active;
  const currency = await db.query(
    "SELECT active,decimal_places FROM company_currencies WHERE company_id=$1 AND id=$2 FOR SHARE",
    [companyId, input.currencyId],
  );
  if (!currency.rows[0]) conflict("العملة يجب أن تكون من الشركة نفسها");
  if (
    (!previous || reactivated || previous.currencyId !== input.currencyId) &&
    !currency.rows[0].active
  )
    conflict("اختر عملة فعالة من الشركة نفسها");
  const places = currency.rows[0].decimal_places as number;
  for (const field of [
    "salePrice1",
    "salePrice2",
    "salePrice3",
    "purchasePrice",
  ] as const) {
    if ((input[field].split(".")[1]?.length ?? 0) > places)
      throw new HttpError(
        400,
        "currency_precision",
        "سعر الصنف يتجاوز دقة العملة المختارة",
      );
  }
  if (input.shelfId !== null) {
    const shelf=await db.query(
      "SELECT name,archived FROM item_shelves WHERE company_id=$1 AND id=$2 FOR SHARE",
      [companyId,input.shelfId],
    );
    if (!shelf.rows[0]) conflict("اختر رفًا تابعًا للشركة نفسها");
    if (shelf.rows[0].name !== input.shelf)
      conflict("اسم الرف لا يطابق كرت الرف المرتبط");
    if ((!previous || reactivated || previous.shelfId !== input.shelfId)
      && shelf.rows[0].archived)
      conflict("لا يمكن ربط صنف برف مؤرشف جديد");
  }
  if (input.compositionId !== null) {
    const composition = await db.query(
      "SELECT active FROM item_compositions WHERE company_id=$1 AND id=$2 FOR SHARE",
      [companyId, input.compositionId],
    );
    if (!composition.rows[0]) conflict("التركيب يجب أن يكون من الشركة نفسها");
    if ((!previous || reactivated || previous.compositionId !== input.compositionId)
      && !composition.rows[0].active)
      conflict("اختر تركيبًا غير مؤرشف من الشركة نفسها");
  }
  if (input.agentId !== null) {
    const agent = await db.query(
      "SELECT active FROM item_agents WHERE company_id=$1 AND id=$2 FOR SHARE",
      [companyId, input.agentId],
    );
    if (!agent.rows[0]) conflict("الوكيل يجب أن يكون من الشركة نفسها");
    if (
      (!previous || reactivated || previous.agentId !== input.agentId) &&
      !agent.rows[0].active
    )
      conflict("اختر وكيلًا فعالًا من الشركة نفسها");
  }
}

export const itemFieldColumns = [
  ["name", "name"],
  ["imageId", "image_id"],
  ["englishName", "english_name"],
  ["shelf", "shelf"],
  ["shelfId", "shelf_id"],
  ["barcode", "barcode"],
  ["legacyId", "legacy_id"],
  ["agentId", "agent_id"],
  ["compositionId", "composition_id"],
  ["unit1Name", "unit1_name"],
  ["unit2Name", "unit2_name"],
  ["unit3Name", "unit3_name"],
  ["factor2", "factor2"],
  ["factor3", "factor3"],
  ["defaultSaleUnit", "default_sale_unit"],
  ["salePrice1", "sale_price1"],
  ["salePrice2", "sale_price2"],
  ["salePrice3", "sale_price3"],
  ["purchasePrice", "purchase_price"],
  ["commissionRate", "commission_rate"],
  ["clearanceFrom", "clearance_from"],
  ["clearanceTo", "clearance_to"],
  ["settlementApprovalDate", "settlement_approval_date"],
  ["settlementDisplayDate", "settlement_display_date"],
  ["purchaseFactor", "purchase_factor"],
  ["currencyId", "currency_id"],
  ["reorderLimit", "reorder_limit"],
  ["orderQuantity", "order_quantity"],
  ["searchKeys", "search_keys"],
  ["purchaseNotes", "purchase_notes"],
  ["orderStoppedUntil", "order_stopped_until"],
  ["hasExpiry", "has_expiry"],
  ["active", "active"],
] as const;

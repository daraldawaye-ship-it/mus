import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "../db.ts";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type {
  InventorySettings,
  StockBalance,
  StockMovement,
  StockMovementKind,
  StockOperation,
} from "../../../../packages/contracts/src/inventory.ts";
import { normalizeRate } from "../../../../packages/contracts/src/masters.ts";
import { conflict } from "./masters.ts";
import { HttpError, missing } from "../errors.ts";
import { moneyString, moneyUnits, quantum } from "./finance.ts";
import { audit } from "./audit.ts";

export const inventorySettingsSelect = `SELECT s.*,c.id AS base_currency_id,
  c.code AS base_currency_code,c.decimal_places AS base_decimal_places
  FROM inventory_settings s LEFT JOIN finance_settings f ON f.company_id=s.company_id
  LEFT JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id`;
export function inventorySettingsDTO(row: QueryResultRow): InventorySettings {
  return {
    companyId: row.company_id,
    inventoryAccountId: row.inventory_account_id,
    salesAccountId: row.sales_account_id,
    cogsAccountId: row.cogs_account_id,
    surplusAccountId: row.surplus_account_id,
    shortageAccountId: row.shortage_account_id,
    costingMethod: row.costing_method,
    allowNegative: row.allow_negative,
    revision: row.revision,
    baseCurrencyId: row.base_currency_id ?? null,
    baseCurrencyCode: row.base_currency_code ?? null,
    baseDecimalPlaces: row.base_decimal_places ?? null,
  };
}
export async function getInventorySettings(
  db: Database,
  companyId: number,
): Promise<InventorySettings | null> {
  const result = await db.query(
    `${inventorySettingsSelect} WHERE s.company_id=$1`,
    [companyId],
  );
  return result.rows[0] ? inventorySettingsDTO(result.rows[0]) : null;
}
export async function requireInventorySettings(
  db: Database,
  companyId: number,
): Promise<
  InventorySettings & { baseCurrencyId: number; baseDecimalPlaces: number }
> {
  const settings = await getInventorySettings(db, companyId);
  if (!settings)
    conflict("حدد حسابات المخزون والمبيعات والتكلفة وفروق الجرد قبل الترحيل");
  if (settings.baseCurrencyId === null || settings.baseDecimalPlaces === null)
    conflict("حدد العملة الأساسية للشركة قبل ترحيل المخزون");
  return settings as InventorySettings & {
    baseCurrencyId: number;
    baseDecimalPlaces: number;
  };
}

export interface StockItemSnapshot {
  id: number;
  code: string;
  name: string;
  factor2: number;
  factor3: number;
  unit1Name: string;
  unit2Name: string;
  unit3Name: string;
  hasExpiry: boolean;
}
export async function itemStockSnapshot(
  db: Database,
  companyId: number,
  itemId: number,
  allowInactive = false,
): Promise<StockItemSnapshot> {
  const result = await db.query(
    "SELECT * FROM items WHERE company_id=$1 AND id=$2 FOR SHARE",
    [companyId, itemId],
  );
  const row = result.rows[0];
  if (!row || (!row.active && !allowInactive))
    conflict("اختر صنفًا فعالًا من الشركة");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    factor2: row.factor2,
    factor3: row.factor3,
    unit1Name: row.unit1_name,
    unit2Name: row.unit2_name,
    unit3Name: row.unit3_name,
    hasExpiry: row.has_expiry,
  };
}
export function stockUnitMultiplier(
  item: Pick<StockItemSnapshot, "factor2" | "factor3">,
  unit: 1 | 2 | 3,
): bigint {
  if ((unit === 2 && item.factor2 === 1) || (unit === 3 && item.factor3 === 1))
    throw new HttpError(
      400,
      "inactive_unit",
      "هذا المستوى من الوحدة غير مفعل للصنف",
    );
  return unit === 1
    ? BigInt(item.factor2) * BigInt(item.factor3)
    : unit === 2
      ? BigInt(item.factor3)
      : 1n;
}
export async function checkStockLocation(
  db: Database,
  companyId: number,
  locationId: number,
): Promise<{ branchId: number }> {
  const result = await db.query(
    "SELECT l.branch_id FROM locations l JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id WHERE l.company_id=$1 AND l.id=$2 AND l.active AND b.active FOR SHARE OF l,b",
    [companyId, locationId],
  );
  if (!result.rows[0]) conflict("اختر موقعًا فعالًا ضمن فرع فعال من الشركة");
  return { branchId: result.rows[0].branch_id };
}
export async function assertStockChronology(
  db: Database,
  companyId: number,
  itemId: number,
  documentDate: string,
): Promise<void> {
  const result = await db.query(
    "SELECT max(document_date)::text AS last_date FROM stock_movements WHERE company_id=$1 AND item_id=$2",
    [companyId, itemId],
  );
  if (result.rows[0].last_date && documentDate < result.rows[0].last_date)
    conflict(
      "لا يمكن ترحيل حركة بتاريخ أسبق من آخر حركة للصنف؛ تكلفة المتوسط تتبع ترتيب الترحيل",
    );
}
function roundedRatio(
  numerator: bigint,
  denominator: bigint,
  step: bigint,
): bigint {
  const divisor = denominator * step;
  return (
    (numerator / divisor + ((numerator % divisor) * 2n >= divisor ? 1n : 0n)) *
    step
  );
}
/** Perpetual weighted average; a full withdrawal consumes the exact residual value. */
export function weightedStockCost(
  quantity: bigint,
  valueBase: bigint,
  withdrawn: bigint,
  basePlaces: number,
): bigint {
  if (quantity <= 0n || withdrawn <= 0n || withdrawn > quantity)
    throw new Error("Invalid stock valuation withdrawal");
  return withdrawn === quantity
    ? valueBase
    : roundedRatio(valueBase * withdrawn, quantity, quantum(basePlaces));
}
function fractionQuantity(
  numerator: bigint,
  denominator: bigint,
): StockBalance["quantityUnit1"] {
  if (numerator === 0n)
    return { numerator: "0", denominator: "1", decimal: "0" };
  let a = numerator,
    b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const n = numerator / a,
    d = denominator / a;
  let remaining = d,
    twos = 0,
    fives = 0;
  while (remaining % 2n === 0n) {
    remaining /= 2n;
    twos++;
  }
  while (remaining % 5n === 0n) {
    remaining /= 5n;
    fives++;
  }
  let decimal: string | null = null;
  if (remaining === 1n) {
    const places = Math.max(twos, fives);
    if (places === 0) decimal = n.toString();
    else {
      const value = ((n * 10n ** BigInt(places)) / d)
        .toString()
        .padStart(places + 1, "0");
      const tail = value.slice(-places).replace(/0+$/, "");
      decimal = value.slice(0, -places) + (tail ? `.${tail}` : "");
    }
  }
  return { numerator: n.toString(), denominator: d.toString(), decimal };
}
export const stockBalanceFrom = `FROM stock_balances s
  JOIN items i ON i.company_id=s.company_id AND i.id=s.item_id
  JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id
  JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id
  JOIN stock_item_valuations v ON v.company_id=s.company_id AND v.item_id=s.item_id
  JOIN finance_settings f ON f.company_id=s.company_id
  JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id`;
export const stockBalanceSelect = `SELECT s.*,i.code AS item_code,i.name AS item_name,
  i.factor2,i.factor3,i.unit1_name,i.unit2_name,i.unit3_name,l.name AS location_name,
  b.name AS branch_name,v.quantity_smallest AS pooled_quantity_smallest,
  v.value_base AS pooled_value_base,c.code AS base_currency_code ${stockBalanceFrom}`;
export function stockBalanceDTO(row: QueryResultRow): StockBalance {
  return {
    id: row.id,
    companyId: row.company_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    locationId: row.location_id,
    locationName: row.location_name,
    branchName: row.branch_name,
    expiryDate: row.batch_key || null,
    quantitySmallest: row.quantity_smallest,
    quantityUnit1: fractionQuantity(
      BigInt(row.quantity_smallest),
      BigInt(row.factor2) * BigInt(row.factor3),
    ),
    unit1Name: row.unit1_name,
    unit2Name: row.unit2_name,
    unit3Name: row.unit3_name,
    factor2: row.factor2,
    factor3: row.factor3,
    pooledQuantitySmallest: row.pooled_quantity_smallest,
    pooledValueBase: normalizeRate(row.pooled_value_base),
    baseCurrencyCode: row.base_currency_code,
  };
}
export const stockMovementFrom = `FROM stock_movements m JOIN items i ON i.company_id=m.company_id AND i.id=m.item_id
  JOIN locations l ON l.company_id=m.company_id AND l.id=m.location_id
  JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id JOIN users u ON u.id=m.created_by`;
export const stockMovementSelect = `SELECT m.*,m.document_date::text AS date_text,i.code AS item_code,i.name AS item_name,l.name AS location_name,l.branch_id,b.name AS branch_name,u.display_name AS created_by_name ${stockMovementFrom}`;
export function stockMovementDTO(row: QueryResultRow): StockMovement {
  return {
    id: row.id,
    companyId: row.company_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    locationId: row.location_id,
    locationName: row.location_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    expiryDate: row.batch_key || null,
    quantitySmallest: row.quantity_smallest,
    costBase: normalizeRate(row.cost_base),
    kind: row.kind,
    documentDate: row.date_text,
    invoiceId: row.invoice_id,
    invoiceLineId: row.invoice_line_id,
    originalMovementId: row.original_movement_id,
    operationId: row.operation_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export async function loadStockOperation(
  db: Database,
  companyId: number,
  operationId: number,
): Promise<StockOperation> {
  const result = await db.query(
    "SELECT o.*,o.document_date::text AS date_text,u.display_name AS created_by_name FROM stock_operations o JOIN users u ON u.id=o.created_by WHERE o.company_id=$1 AND o.id=$2",
    [companyId, operationId],
  );
  const row = result.rows[0];
  if (!row) missing();
  const moves = await db.query(
    `${stockMovementSelect} WHERE m.company_id=$1 AND m.operation_id=$2 ORDER BY m.id`,
    [companyId, operationId],
  );
  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    documentDate: row.date_text,
    description: row.description,
    financialDocumentId: row.financial_document_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    movements: moves.rows.map(stockMovementDTO),
  };
}
export async function findStockOperation(
  db: Database,
  companyId: number,
  key: string,
  payload: unknown,
): Promise<number | null> {
  const result = await db.query(
    "SELECT id,creation_payload=$3::jsonb AS same_payload FROM stock_operations WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, key, JSON.stringify(payload)],
  );
  if (!result.rows[0]) return null;
  if (!result.rows[0].same_payload)
    conflict(
      "مفتاح العملية مستخدم لبيانات مختلفة؛ أعد إرسال العملية الأصلية أو ابدأ عملية جديدة",
    );
  return result.rows[0].id as number;
}
export async function createStockOperation(
  client: PoolClient,
  companyId: number,
  user: User,
  kind: "transfer" | "adjustment",
  payload: {
    documentDate: string;
    description: string;
    idempotencyKey: string;
  },
): Promise<number> {
  const result = await client.query(
    "INSERT INTO stock_operations(company_id,kind,document_date,description,created_by,idempotency_key,creation_payload) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [
      companyId,
      kind,
      payload.documentDate,
      payload.description,
      user.id,
      payload.idempotencyKey,
      JSON.stringify(payload),
    ],
  );
  return result.rows[0].id;
}

export interface ApplyStockInput {
  itemId: number;
  locationId: number;
  quantitySmallest: bigint;
  kind: StockMovementKind;
  documentDate: string;
  expiryDate?: string | null;
  /** Exact magnitude in 10^-6 base currency units. Required for incoming stock. */
  costBase?: bigint;
  invoiceId?: number | null;
  invoiceLineId?: number | null;
  operationId?: number | null;
  originalMovementId?: number | null;
  allowExpired?: boolean;
  allowInactive?: boolean;
}
export interface StockAllocation {
  movementId: number;
  expiryDate: string | null;
  quantitySmallest: string;
  costBase: string;
}
/** Caller holds the company mutation lock and includes all journals/audit in this transaction. */
export async function applyStock(
  client: PoolClient,
  companyId: number,
  userId: number,
  input: ApplyStockInput,
): Promise<{ costBase: bigint; allocations: StockAllocation[] }> {
  const item = await itemStockSnapshot(
    client,
    companyId,
    input.itemId,
    input.allowInactive,
  );
  await checkStockLocation(client, companyId, input.locationId);
  await assertStockChronology(
    client,
    companyId,
    input.itemId,
    input.documentDate,
  );
  const settings = await requireInventorySettings(client, companyId);
  const quantity = input.quantitySmallest;
  if (quantity === 0n)
    throw new Error("Stock movement quantity must be nonzero");
  const incoming = quantity > 0n,
    magnitude = incoming ? quantity : -quantity;
  if (magnitude >= 10n ** 40n)
    throw new HttpError(
      400,
      "quantity_overflow",
      "كمية المخزون تتجاوز الحد المدعوم",
    );
  const batchKey = input.expiryDate ?? "";
  if (!item.hasExpiry && batchKey !== "")
    conflict("الصنف لا يتتبع تاريخ انتهاء؛ اترك تاريخ الدفعة فارغًا");
  if (incoming && item.hasExpiry && !batchKey)
    conflict("تاريخ انتهاء الدفعة مطلوب لهذا الصنف");
  if (batchKey && batchKey < input.documentDate && !input.allowExpired)
    conflict("الدفعة منتهية بتاريخ المستند");
  await client.query(
    "INSERT INTO stock_item_valuations(company_id,item_id,quantity_smallest,value_base) VALUES($1,$2,0,0) ON CONFLICT(company_id,item_id) DO NOTHING",
    [companyId, item.id],
  );
  const values = await client.query(
    "SELECT * FROM stock_item_valuations WHERE company_id=$1 AND item_id=$2 FOR UPDATE",
    [companyId, item.id],
  );
  const previousQuantity = BigInt(values.rows[0].quantity_smallest),
    previousValue = moneyUnits(values.rows[0].value_base);
  let cost: bigint;
  const batches: { key: string; quantity: bigint }[] = [];
  if (incoming) {
    if (input.costBase === undefined || input.costBase < 0n)
      throw new Error("Incoming stock requires a nonnegative exact cost");
    cost = input.costBase;
    if (cost % quantum(settings.baseDecimalPlaces) !== 0n)
      throw new HttpError(
        400,
        "currency_precision",
        "تكلفة المخزون تتجاوز دقة العملة الأساسية",
      );
    batches.push({ key: batchKey, quantity: magnitude });
  } else {
    const parameters: unknown[] = [companyId, item.id, input.locationId];
    let condition = "";
    if (input.expiryDate != null) {
      parameters.push(input.expiryDate);
      condition = ` AND batch_key=$${parameters.length}`;
    }
    if (!input.allowExpired) {
      parameters.push(input.documentDate);
      condition += ` AND (batch_key='' OR batch_key>=$${parameters.length})`;
    }
    const available = await client.query(
      `SELECT * FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND location_id=$3 AND quantity_smallest>0${condition} ORDER BY batch_key ASC,id ASC FOR UPDATE`,
      parameters,
    );
    let remaining = magnitude;
    for (const batch of available.rows) {
      const availableQuantity = BigInt(batch.quantity_smallest),
        taken = availableQuantity < remaining ? availableQuantity : remaining;
      if (taken > 0n) batches.push({ key: batch.batch_key, quantity: taken });
      remaining -= taken;
      if (remaining === 0n) break;
    }
    if (remaining > 0n || magnitude > previousQuantity)
      conflict(
        "الرصيد المتاح في الموقع أو الدفعة لا يكفي؛ المخزون السالب غير مفعل في هذه المرحلة",
      );
    cost =
      input.costBase ??
      weightedStockCost(
        previousQuantity,
        previousValue,
        magnitude,
        settings.baseDecimalPlaces,
      );
    if (
      cost < 0n ||
      cost > previousValue ||
      cost % quantum(settings.baseDecimalPlaces) !== 0n
    )
      conflict("تكلفة الإخراج لا تطابق رصيد المخزون ودقة العملة الأساسية");
    if (magnitude === previousQuantity && cost !== previousValue)
      conflict("إخراج كامل المخزون يجب أن يستهلك قيمته المتبقية كاملة");
  }
  const nextQuantity = previousQuantity + quantity,
    signedCost = incoming ? cost : -cost,
    nextValue = previousValue + signedCost;
  if (nextQuantity >= 10n ** 40n || nextValue >= 10n ** 32n)
    throw new HttpError(
      400,
      "stock_overflow",
      "رصيد المخزون أو قيمته يتجاوز الحد المدعوم",
    );
  await client.query(
    "UPDATE stock_item_valuations SET quantity_smallest=$1,value_base=$2 WHERE company_id=$3 AND item_id=$4",
    [nextQuantity.toString(), moneyString(nextValue), companyId, item.id],
  );
  const allocations: StockAllocation[] = [];
  let residualCost = cost,
    residualQuantity = magnitude;
  for (const [index, batch] of batches.entries()) {
    const allocationCost =
      index === batches.length - 1
        ? residualCost
        : roundedRatio(
            residualCost * batch.quantity,
            residualQuantity,
            quantum(settings.baseDecimalPlaces),
          );
    residualCost -= allocationCost;
    residualQuantity -= batch.quantity;
    const signedQuantity = incoming ? batch.quantity : -batch.quantity,
      batchCost = incoming ? allocationCost : -allocationCost;
    if (incoming)
      await client.query(
        "INSERT INTO stock_balances(company_id,item_id,location_id,batch_key,quantity_smallest) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,item_id,location_id,batch_key) DO UPDATE SET quantity_smallest=stock_balances.quantity_smallest+EXCLUDED.quantity_smallest,updated_at=clock_timestamp()",
        [
          companyId,
          item.id,
          input.locationId,
          batch.key,
          batch.quantity.toString(),
        ],
      );
    else
      await client.query(
        "UPDATE stock_balances SET quantity_smallest=quantity_smallest-$1,updated_at=clock_timestamp() WHERE company_id=$2 AND item_id=$3 AND location_id=$4 AND batch_key=$5",
        [
          batch.quantity.toString(),
          companyId,
          item.id,
          input.locationId,
          batch.key,
        ],
      );
    const move = await client.query(
      "INSERT INTO stock_movements(company_id,item_id,location_id,batch_key,quantity_smallest,cost_base,kind,document_date,created_by,invoice_id,invoice_line_id,operation_id,original_movement_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
      [
        companyId,
        item.id,
        input.locationId,
        batch.key,
        signedQuantity.toString(),
        moneyString(batchCost),
        input.kind,
        input.documentDate,
        userId,
        input.invoiceId ?? null,
        input.invoiceLineId ?? null,
        input.operationId ?? null,
        input.originalMovementId ?? null,
      ],
    );
    allocations.push({
      movementId: move.rows[0].id,
      expiryDate: batch.key || null,
      quantitySmallest: signedQuantity.toString(),
      costBase: moneyString(batchCost),
    });
  }
  return { costBase: signedCost, allocations };
}

export async function auditStockOperation(
  client: PoolClient,
  companyId: number,
  user: User,
  operationId: number,
  before: object | null = null,
): Promise<StockOperation> {
  const operation = await loadStockOperation(client, companyId, operationId);
  await audit(
    client,
    user,
    operation.kind === "transfer" ? "stock.transfer" : "stock.adjustment",
    "stockOperation",
    operation.id,
    before,
    operation,
    companyId,
  );
  return operation;
}

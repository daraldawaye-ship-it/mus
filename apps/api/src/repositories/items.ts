import type { QueryResultRow } from "pg";
import type {
  Item,
  ItemAgent,
} from "../../../../packages/contracts/src/index.ts";
import { normalizeRate } from "../../../../packages/contracts/src/index.ts";

const iso = (value: string | Date): string => new Date(value).toISOString();
const identity = (row: QueryResultRow) => ({
  id: row.id as number,
  companyId: row.company_id as number,
  revision: row.revision as number,
  createdBy: row.created_by as number,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
export function itemAgentDTO(row: QueryResultRow): ItemAgent {
  return {
    ...identity(row),
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    active: row.active,
  };
}
export function itemDTO(row: QueryResultRow): Item {
  return {
    ...identity(row),
    code: row.code,
    name: row.name,
    englishName: row.english_name,
    barcode: row.barcode,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    agentActive: row.agent_active ?? null,
    unit1Name: row.unit1_name,
    unit2Name: row.unit2_name,
    unit3Name: row.unit3_name,
    factor2: row.factor2,
    factor3: row.factor3,
    salePrice1: normalizeRate(row.sale_price1),
    salePrice2: normalizeRate(row.sale_price2),
    salePrice3: normalizeRate(row.sale_price3),
    purchasePrice: normalizeRate(row.purchase_price),
    purchaseFactor: row.purchase_factor,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    currencyName: row.currency_name,
    currencyDecimalPlaces: row.currency_decimal_places,
    currencyActive: row.currency_active,
    reorderLimit: normalizeRate(row.reorder_limit),
    orderQuantity: normalizeRate(row.order_quantity),
    searchKeys: row.search_keys,
    purchaseNotes: row.purchase_notes,
    orderStoppedUntil: row.order_stopped_until,
    hasExpiry: row.has_expiry,
    active: row.active,
  };
}
export const itemAgentSelect = "SELECT a.* FROM item_agents a";
export const itemFrom =
  "FROM items i JOIN company_currencies c ON c.company_id=i.company_id AND c.id=i.currency_id LEFT JOIN item_agents a ON a.company_id=i.company_id AND a.id=i.agent_id";
export const itemSelect =
  "SELECT i.*,i.order_stopped_until::text AS order_stopped_until,a.name AS agent_name,a.active AS agent_active,c.code AS currency_code,c.name AS currency_name,c.decimal_places AS currency_decimal_places,c.active AS currency_active " +
  itemFrom;

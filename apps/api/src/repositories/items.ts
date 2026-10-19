import type { QueryResultRow } from "pg";
import type {
  Item,
  ItemAgent,
  ItemComposition,
  ItemShelf,
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
export function itemCompositionDTO(row: QueryResultRow): ItemComposition {
  return {
    ...identity(row),
    arabicName: row.arabic_name,
    englishName: row.english_name,
    description: row.description,
    saleNotes: row.sale_notes,
    productForm: row.product_form,
    priceSplitThreshold: row.price_split_threshold === null || row.price_split_threshold === undefined
      ? null : String(row.price_split_threshold),
    originalItemId: row.original_item_id ?? null,
    active: row.active,
    identicalAlternative: row.identical_alternative,
    nonInterchangeable: row.non_interchangeable,
  };
}
export const itemCompositionSelect = "SELECT f.* FROM item_compositions f";

export function itemShelfDTO(row: QueryResultRow): ItemShelf {
  return {
    ...identity(row),
    name: row.name,
    groupLetter: row.group_letter,
    groupOrder: row.group_order,
    slotNumber: row.slot_number,
    archived: row.archived,
    vitrine: row.vitrine,
  };
}
export const itemShelfSelect = "SELECT s.* FROM item_shelves s";

export function itemDTO(row: QueryResultRow): Item {
  return {
    ...identity(row),
    code: row.code,
    imageId: row.image_id ?? null,
    name: row.name,
    englishName: row.english_name,
    shelf: row.shelf ?? "",
    shelfId: row.shelf_id ?? null,
    barcode: row.barcode,
    legacyId: row.legacy_id,
    agentId: row.agent_id,
    supplierAccountId: row.supplier_account_id ?? null,
    supplierInferred: row.supplier_inferred === true,
    supplierAccountCode: row.supplier_account_code ?? null,
    supplierAccountName: row.supplier_account_name ?? null,
    compositionId: row.composition_id ?? null,
    compositionArabicName: row.composition_arabic_name ?? null,
    compositionEnglishName: row.composition_english_name ?? null,
    compositionActive: row.composition_active ?? null,
    agentName: row.agent_name ?? null,
    agentActive: row.agent_active ?? null,
    unit1Name: row.unit1_name,
    unit2Name: row.unit2_name,
    unit3Name: row.unit3_name,
    factor2: row.factor2,
    factor3: row.factor3,
    defaultSaleUnit: row.default_sale_unit,
    salePrice1: normalizeRate(row.sale_price1),
    salePrice2: normalizeRate(row.sale_price2),
    salePrice3: normalizeRate(row.sale_price3),
    purchasePrice: normalizeRate(row.purchase_price),
    commissionRate: normalizeRate(row.commission_rate),
    clearanceFrom: row.clearance_from_text ?? null,
    clearanceTo: row.clearance_to_text ?? null,
    settlementApprovalDate: row.settlement_approval_date_text ?? null,
    settlementDisplayDate: row.settlement_display_date_text ?? null,
    purchaseFactor: row.purchase_factor,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    currencyName: row.currency_name,
    currencyDecimalPlaces: row.currency_decimal_places,
    currencyActive: row.currency_active,
    reorderLimit: normalizeRate(row.reorder_limit),
    orderQuantity: normalizeRate(row.order_quantity),
    reserveQuantity: normalizeRate(row.reserve_quantity),
    ...(Object.hasOwn(row, "available_smallest") ? {
      availableSmallest: row.available_smallest === null ? null : String(row.available_smallest),
    } : {}),
    ...(Object.hasOwn(row, "approximate_coverage_days") ? {
      approximateCoverageDays: row.approximate_coverage_days === null
        ? null : normalizeRate(row.approximate_coverage_days),
      coverageAfterReserveDays: row.coverage_after_reserve_days === null
        ? null : normalizeRate(row.coverage_after_reserve_days),
    } : {}),
    searchKeys: row.search_keys,
    purchaseNotes: row.purchase_notes,
    saleNotes: row.sale_notes,
    productForm: row.product_form,
    orderStoppedUntil: row.order_stopped_until,
    hasExpiry: row.has_expiry,
    nearestExpiryDate: row.nearest_expiry_date_text ?? null,
    active: row.active,
  };
}
export const itemAgentSelect = "SELECT a.* FROM item_agents a";
export const itemFrom =
  "FROM items i JOIN company_currencies c ON c.company_id=i.company_id AND c.id=i.currency_id LEFT JOIN item_agents a ON a.company_id=i.company_id AND a.id=i.agent_id LEFT JOIN accounts supplier ON supplier.company_id=i.company_id AND supplier.id=i.supplier_account_id LEFT JOIN item_compositions f ON f.company_id=i.company_id AND f.id=i.composition_id";
export const itemSelect =
  "SELECT i.*,i.order_stopped_until::text AS order_stopped_until,i.nearest_expiry_date::text AS nearest_expiry_date_text,i.clearance_from::text AS clearance_from_text,i.clearance_to::text AS clearance_to_text,i.settlement_approval_date::text AS settlement_approval_date_text,i.settlement_display_date::text AS settlement_display_date_text,a.name AS agent_name,a.active AS agent_active,supplier.code AS supplier_account_code,supplier.name AS supplier_account_name,f.arabic_name AS composition_arabic_name,f.english_name AS composition_english_name,f.active AS composition_active,c.code AS currency_code,c.name AS currency_name,c.decimal_places AS currency_decimal_places,c.active AS currency_active " +
  itemFrom;

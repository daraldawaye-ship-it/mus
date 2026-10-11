import type { QueryResultRow } from "pg";
import type {
  Account,
  AccountLink,
  Branch,
  CompanyCurrency,
  ExchangeRate,
  FinanceSettings,
  Location,
} from "../../../../packages/contracts/src/index.ts";
import { normalizeRate } from "../../../../packages/contracts/src/index.ts";

type Row = QueryResultRow;
const iso = (value: Date | string): string => new Date(value).toISOString();
const identity = (row: Row) => ({
  id: row.id as number,
  companyId: row.company_id as number,
  createdBy: row.created_by as number,
  createdAt: iso(row.created_at),
});
export function accountDTO(row: Row): Account {
  return {
    ...identity(row),
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    parentCode: row.parent_code ?? null,
    parentName: row.parent_name ?? null,
    kind: row.kind,
    category: row.category,
    normalSide: row.normal_side,
    active: row.active,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
  };
}
export function accountLinkDTO(row: Row): AccountLink {
  return {
    companyId: row.company_id,
    purpose: row.purpose,
    accountId: row.account_id ?? null,
    accountCode: row.account_code ?? null,
    accountName: row.account_name ?? null,
  };
}
export function currencyDTO(row: Row): CompanyCurrency {
  return {
    ...identity(row),
    code: row.code,
    name: row.name,
    decimalPlaces: row.decimal_places,
    active: row.active,
  };
}
export function financeSettingsDTO(row: Row): FinanceSettings {
  return {
    companyId: row.company_id,
    baseCurrencyId: row.base_currency_id,
    baseCurrencyCode: row.base_currency_code,
    baseCurrencyName: row.base_currency_name,
  };
}
export function exchangeRateDTO(row: Row): ExchangeRate {
  return {
    ...identity(row),
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    baseCurrencyId: row.base_currency_id,
    baseCurrencyCode: row.base_currency_code,
    rate: normalizeRate(row.rate),
    effectiveAt: iso(row.effective_at),
    source: row.source,
    active: row.active,
  };
}
export function branchDTO(row: Row): Branch {
  return {
    ...identity(row),
    code: row.code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    active: row.active,
  };
}
export function locationDTO(row: Row): Location {
  return {
    ...identity(row),
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    active: row.active,
    branchName: row.branch_name,
    branchActive: row.branch_active,
    effectiveActive: row.active && row.branch_active,
  };
}
export const accountSelect =
  "SELECT a.*,p.code AS parent_code,p.name AS parent_name FROM accounts a LEFT JOIN accounts p ON p.company_id=a.company_id AND p.id=a.parent_id";
export const currencySelect = "SELECT c.* FROM company_currencies c";
export const settingsSelect =
  "SELECT s.*,c.code AS base_currency_code,c.name AS base_currency_name FROM finance_settings s JOIN company_currencies c ON c.company_id=s.company_id AND c.id=s.base_currency_id";
export const exchangeRateSelect =
  "SELECT r.*,c.code AS currency_code,b.code AS base_currency_code FROM exchange_rates r JOIN company_currencies c ON c.company_id=r.company_id AND c.id=r.currency_id JOIN company_currencies b ON b.company_id=r.company_id AND b.id=r.base_currency_id";
export const branchSelect = "SELECT b.* FROM branches b";
export const locationSelect =
  "SELECT l.*,b.name AS branch_name,b.active AS branch_active FROM locations l JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id";

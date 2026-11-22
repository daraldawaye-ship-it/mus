// Dar Aldawa's statement cutover. Other companies and specialized ledgers keep
// their existing date rules. The API uses the authenticated user's owner flag.
const DAR_ALDAWA_COMPANY_ID = 2;
export const DAR_ALDAWA_STAFF_LEDGER_START = "2026-11-01";

export function accountLedgerStartLimit(companyId:number,owner:boolean): string|undefined {
  return companyId===DAR_ALDAWA_COMPANY_ID&&!owner ? DAR_ALDAWA_STAFF_LEDGER_START : undefined;
}

/** Normalize a staff start, including dates arriving from copied filter links. */
export function applyAccountLedgerStartLimit<T extends string|null>(date:T,min:string|undefined): T|string {
  if (!min) return date;
  if (!date || date<min || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return min;
  const calendar = new Date(date);
  return !Number.isNaN(calendar.getTime()) && calendar.toISOString().slice(0,10)===date ? date : min;
}

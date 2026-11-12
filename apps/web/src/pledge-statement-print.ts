import type { AccountLedgerLine, AccountLedgerTotals } from "../../../packages/contracts/src/index";
import { api } from "./api";

export type PledgeStatementData = {
  items: AccountLedgerLine[];
  total: number;
  account: { id: number; code: string; name: string };
  totals: AccountLedgerTotals;
};

/** Load only the requested pledged account through its commerce.view-scoped endpoint. */
export async function fetchPledgeStatement(
  companyId: number,
  accountId: number,
): Promise<PledgeStatementData> {
  const rows: AccountLedgerLine[] = [];
  for (let page = 1; page <= 1000; page++) {
    const result = await api<PledgeStatementData>(
      `/companies/${companyId}/pledges/${accountId}/ledger?` +
      new URLSearchParams({
        page: String(page),
        pageSize: "100",
        sort: "documentDate:asc,documentId:asc,lineNumber:asc",
      }),
    );
    if (result.account.id !== accountId)
      throw new Error("كشف الحساب لا يخص الرهن المحدد.");
    rows.push(...result.items);
    if (rows.length >= result.total) return { ...result, items: rows };
    if (!result.items.length) throw new Error("تعذر استكمال سطور كشف الرهن.");
  }
  throw new Error("كشف الرهن كبير جدًا للطباعة دفعة واحدة.");
}

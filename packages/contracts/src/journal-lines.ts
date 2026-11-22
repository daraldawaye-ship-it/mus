import type { FinancialDocumentStatus } from "./index.ts";

export interface JournalLine {
  id: number;
  documentId: number;
  lineNumber: number;
  number: string;
  documentDate: string;
  status: FinancialDocumentStatus;
  accountId: number;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  currencyCode: string;
  description: string;
}

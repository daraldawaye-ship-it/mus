/** Do not run wide item typeahead searches before the third character.
 * Unicode code points prevent counting an Arabic surrogate-pair as two.
 * Applies to name, code and barcode lookups alike in sales/purchase invoices.
 */
export const MIN_INVOICE_ITEM_SEARCH_LENGTH = 3;
export function canSearchInvoiceItem(value: string): boolean {
  return Array.from(value.replace(/[\\s\\p{M}]/gu, "")).length >= MIN_INVOICE_ITEM_SEARCH_LENGTH;
}

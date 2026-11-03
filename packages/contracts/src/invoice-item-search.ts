/** Do not run wide item typeahead searches before the third character.
 * Unicode code points prevent counting an Arabic surrogate-pair as two.
 * Applies to name, code and barcode lookups alike in sales/purchase invoices.
 */
export const MIN_INVOICE_ITEM_SEARCH_LENGTH = 3;
export function canSearchInvoiceItem(value: string): boolean {
  return Array.from(value.replace(/[\s\p{M}]/gu, "")).length >= MIN_INVOICE_ITEM_SEARCH_LENGTH;
}

/** Match typed item-name words in their original order, allowing omitted words
 * between them. Inputs are already normalized by the local item index. */
export function matchesOrderedItemWords(text: string, words: readonly string[]): boolean {
  let position = 0;
  for (const word of words) {
    const found = text.indexOf(word, position);
    if (found === -1) return false;
    position = found + word.length;
  }
  return true;
}

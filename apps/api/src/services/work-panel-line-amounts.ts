// Both item-dock endpoints select the same exact posted invoice line.
// A line can be split across multiple stock batches. Allocate cumulative
// currency-rounded gross shares so pages never repeat the whole line value.
// Discount and net are intentionally the posted invoice totals, not shares.
export const workPanelLineAllocationSql = `LEFT JOIN LATERAL (
  SELECT sum(abs(part.quantity_smallest)) AS whole,
         coalesce(sum(abs(part.quantity_smallest)) FILTER (WHERE part.id < m.id),0) AS before,
         coalesce(sum(abs(part.quantity_smallest)) FILTER (WHERE part.id <= m.id),0) AS through
  FROM stock_movements part
  WHERE part.company_id=m.company_id AND part.item_id=m.item_id
    AND part.invoice_id=m.invoice_id AND part.invoice_line_id=il.id AND part.kind=m.kind
) allocation ON il.id IS NOT NULL`;

export const workPanelLineAmountColumns = `
  (il.unit_price::numeric * CASE il.unit WHEN 1 THEN 1 WHEN 2 THEN il.factor2
                        WHEN 3 THEN il.factor2::numeric*il.factor3 END)::text AS "unitPriceFirstUnit",
  (round(il.gross * allocation.through / nullif(allocation.whole,0),i.decimal_places) -
   round(il.gross * allocation.before / nullif(allocation.whole,0),i.decimal_places))::text AS "lineValue",
  CASE WHEN il.id IS NOT NULL THEN i.discount::text END AS "invoiceDiscount",
  CASE WHEN il.id IS NOT NULL THEN i.total::text END AS "invoiceNet"`;

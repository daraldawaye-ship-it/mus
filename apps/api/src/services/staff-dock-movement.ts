export function mayReadStaffDockMovement(user:{owner:boolean;suspended:boolean;archived:boolean},
  employee:{active:boolean;positions:readonly string[]}|null|undefined){
  return !user.suspended&&!user.archived&&(user.owner||
    !!employee?.active&&employee.positions.some(position=>position==="sales"||position==="cashier"));
}

export const staffDockMovementSql=`
SELECT m.id,m.kind,m.document_date::text AS "documentDate",
       m.quantity_smallest::text AS "quantitySmallest",
       il.unit_price::text AS "postedUnitPrice",
       so.id AS "operationId",
       CASE WHEN il.factor2>0 AND il.factor3>0
         THEN (il.factor2::bigint*il.factor3::bigint)::text END AS "firstUnitMultiplier"
FROM stock_movements m
JOIN items item ON item.company_id=m.company_id AND item.id=m.item_id AND item.active
LEFT JOIN invoices i ON i.company_id=m.company_id AND i.id=m.invoice_id AND i.posted
LEFT JOIN invoice_lines il ON il.company_id=m.company_id AND il.invoice_id=i.id
  AND il.id=m.invoice_line_id AND il.item_id=m.item_id
LEFT JOIN stock_operations so ON so.company_id=m.company_id AND so.id=m.operation_id
  AND so.kind='adjustment' AND m.kind IN ('adjustment_surplus','adjustment_shortage')
WHERE m.company_id=$1 AND m.item_id=$2
  AND ($3::date IS NULL OR m.document_date>=$3)
  AND ($4::date IS NULL OR m.document_date<=$4)
  AND ((il.id IS NOT NULL AND ((i.kind='purchase' AND m.kind IN ('purchase','purchase_return')) OR
       (NOT $5::boolean AND i.kind='sale' AND m.kind IN ('sale','sales_return')))) OR
       (NOT $5::boolean AND so.id IS NOT NULL AND m.invoice_id IS NULL AND m.invoice_line_id IS NULL))
ORDER BY m.document_date DESC,m.id DESC LIMIT 11 OFFSET $6`;

export const staffDockItemsSql=`
SELECT id,name,code
FROM items
WHERE company_id=$1 AND active AND (name ILIKE $2 OR code ILIKE $2)
ORDER BY name,id LIMIT 11 OFFSET $3`;

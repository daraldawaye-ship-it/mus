import type { Database } from "../db.ts";

export const draftPrintClassificationsSql=`SELECT i.id AS "itemId",c.classification AS "compositionClassification"
  FROM items i LEFT JOIN item_compositions c ON c.company_id=i.company_id AND c.id=i.composition_id
  WHERE i.company_id=$1 AND i.id=ANY($2::integer[])`;

/** Deliberately projects no inventory values or composition-card details. */
export async function readDraftPrintClassifications(db:Database,companyId:number,ids:number[]) {
  return (await db.query(draftPrintClassificationsSql,[companyId,ids])).rows;
}

/**
 * Keep item text and composition text in separate indexed scans. Searching an
 * OR across the display joins prevents PostgreSQL from using these indexes and
 * can repeat the whole scan for every currency. Materialize IDs once, dedupe,
 * then let the normal page query apply tenant/active filters and global sort.
 * $1 is the company, $2 is the same escaped ILIKE pattern used by masterPage.
 */
export const itemLookupSearchPlan = {
  withSql: `WITH item_lookup_matches AS MATERIALIZED (
    SELECT lookup.id FROM items lookup
    WHERE lookup.company_id=$1 AND (
      lookup.name ILIKE $2 OR lookup.english_name ILIKE $2 OR
      lookup.code ILIKE $2 OR lookup.barcode ILIKE $2 OR lookup.search_keys ILIKE $2
    )
    UNION
    SELECT lookup.id FROM item_compositions composition
    JOIN items lookup ON lookup.company_id=composition.company_id AND lookup.composition_id=composition.id
    WHERE composition.company_id=$1 AND (
      composition.arabic_name ILIKE $2 OR composition.english_name ILIKE $2
    )
  )`,
  predicate: "i.id IN (SELECT id FROM item_lookup_matches)",
};

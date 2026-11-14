-- Link imported product rows to their actual market medicine cards.
-- The original file bytes and original row payload remain immutable.
ALTER TABLE market_import_rows
  ADD COLUMN IF NOT EXISTS market_card_id integer
  REFERENCES medicine_market_cards(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS market_import_rows_market_card_id_idx
  ON market_import_rows(market_card_id) WHERE market_card_id IS NOT NULL;

-- Reuse confirmed medicine references already verified in earlier follow-up work.
-- Never infer an ID from composition, scientific-name or ambiguous multiple medicines.
WITH source AS (
  SELECT s.id FROM market_import_sources s
  WHERE s.filename='Priced-Products-(21-10-2021).xls'
),
unique_medicine_refs AS (
  SELECT f.source_id,f.section,f.position,
    max((j.item->>'id')::integer) FILTER (WHERE j.item->>'kind'='medicine') AS medicine_id,
    count(*) FILTER (WHERE j.item->>'kind'='medicine') AS medicine_count
  FROM market_import_row_followups f
  JOIN source s ON s.id=f.source_id
  CROSS JOIN LATERAL jsonb_array_elements(f.card_refs) AS j(item)
  WHERE f.section='All Pricing'
  GROUP BY f.source_id,f.section,f.position
  HAVING count(*) FILTER (WHERE j.item->>'kind'='medicine')=1
)
UPDATE market_import_rows r SET market_card_id=c.id
FROM unique_medicine_refs u
JOIN medicine_market_cards c ON c.id=u.medicine_id
  AND c.kind='medicine' AND c.status='published' AND NOT c.archived
WHERE r.source_id=u.source_id AND r.section=u.section
  AND r.position=u.position AND r.market_card_id IS NULL;

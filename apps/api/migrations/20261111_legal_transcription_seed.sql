-- Apply an owner-reviewed private backfill, if supplied before this migration.
-- Keep the file inventory and the case-record IDs inside their own database.
WITH approved AS MATERIALIZED (
  SELECT r.id, r.updated_by AS actor_id,
         split_part(r.content_text, E'\n[legal-transcription-v1]\n', 2) AS payload
  FROM legal_records r JOIN users u ON u.id=r.updated_by
  WHERE r.kind='report' AND r.document_number='legal-transcription-v1'
    AND u.owner AND NOT u.suspended AND NOT u.archived
    AND strpos(r.content_text, E'\n[legal-transcription-v1]\n') > 0
    AND NOT EXISTS (SELECT 1 FROM legal_record_cases rc WHERE rc.record_id=r.id)
  ORDER BY r.id DESC LIMIT 1
), reviewed AS (
  SELECT (item->>0)::int AS id, (item->>1)::int AS revision,
         item->>2 AS state, (item->>3)::boolean AS file, approved.actor_id
  FROM approved CROSS JOIN LATERAL jsonb_array_elements(approved.payload::jsonb) item
)
UPDATE legal_records r
SET transcription_status=reviewed.state, transcription_file=reviewed.file,
    revision=r.revision+1, updated_at=now(), updated_by=reviewed.actor_id
FROM reviewed
WHERE r.id=reviewed.id AND r.kind='document' AND r.revision=reviewed.revision
  AND r.transcription_status IS NULL;

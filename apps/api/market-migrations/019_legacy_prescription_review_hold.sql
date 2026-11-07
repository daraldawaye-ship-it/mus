-- Put legacy prescriptions published before mandatory administrative image
-- review back into a nonpublic review queue.
-- Card #31463 was temporarily archived on owner's request to block exposure
-- pending this safe migration; only that card is automatically unarchived.
WITH legacy AS (
  SELECT c.id,c.name,c.created_by
  FROM medicine_market_cards c
  WHERE c.kind='prescription' AND c.status='published'
    AND c.created_at < timestamptz '2026-11-07 20:14:37+00'
    AND (NOT c.archived OR c.id=31463)
    AND NOT EXISTS (
      SELECT 1 FROM audit_events a WHERE a.target_type='medicine-market'
        AND a.target_id=c.id AND a.action='medicine-market.review'
        AND a.after_value->>'status'='approved'
    )
), held AS (
  UPDATE medicine_market_cards c
     SET status='pending', archived=false,
         revision=revision+1, updated_at=now()
    FROM legacy l WHERE c.id=l.id
  RETURNING c.id,c.name,c.created_by
), reset_pending AS (
  UPDATE medicine_market_contributions p SET published=false
    FROM held h WHERE p.card_id=h.id AND p.field_key='name'
      AND p.status='pending'
  RETURNING p.card_id
)
INSERT INTO medicine_market_contributions
 (card_id,field_key,previous_value,proposed_value,source,author_id,
  idempotency_key,published)
SELECT h.id,'name','null'::jsonb,to_jsonb(h.name),
  'إعادة الوصفة إلى مراجعة صورة الإدارة قبل النشر',
  h.created_by,
  md5('prescription-admin-photo-review-2026-11-07-'||h.id::text)::uuid,
  false
FROM held h
WHERE NOT EXISTS(
  SELECT 1 FROM medicine_market_contributions p
  WHERE p.card_id=h.id AND p.field_key='name' AND p.status='pending'
)
ON CONFLICT(author_id,idempotency_key) DO NOTHING;

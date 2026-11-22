-- Snapshot the existing legacy options once. Do not keep these descriptive
-- labels in sync with future role/permission edits; new users still get member.
ALTER TABLE user_site_traits DROP CONSTRAINT user_site_traits_traits_check;
ALTER TABLE user_site_traits ADD CONSTRAINT user_site_traits_traits_check CHECK (
  cardinality(traits) <= 12
  AND (cardinality(traits) = 0 OR array_ndims(traits) = 1)
  AND traits <@ ARRAY[
    'admin1','companyEmployee','editor','marketSupervisor','member','chatAllowed',
    'chatGrantor','child','legalCasesAllowed','approved','personallyKnown','monitor'
  ]::text[]
);

WITH legacy_options AS (
  SELECT id, ARRAY_REMOVE(ARRAY[
    CASE WHEN kind='admin' THEN 'admin1' END,
    CASE WHEN editor THEN 'editor' END,
    CASE WHEN kind='supervisor' THEN 'marketSupervisor' END,
    CASE WHEN monitor THEN 'monitor' END
  ]::text[], NULL) AS imported_traits
  FROM users
), missing_options AS (
  SELECT t.user_id, ARRAY(
    SELECT option_name
    FROM unnest(l.imported_traits) WITH ORDINALITY AS opts(option_name, position)
    WHERE NOT (option_name = ANY(t.traits))
    ORDER BY position
  ) AS added
  FROM user_site_traits t JOIN legacy_options l ON l.id=t.user_id
)
UPDATE user_site_traits t
SET traits=t.traits||m.added, revision=t.revision+1, updated_at=now()
FROM missing_options m
WHERE m.user_id=t.user_id AND cardinality(m.added)>0;

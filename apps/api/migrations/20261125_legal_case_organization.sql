-- Administrative organization is additive: never rewrite the original summary.
ALTER TABLE legal_cases ADD COLUMN IF NOT EXISTS case_profile jsonb;
ALTER TABLE legal_cases DROP CONSTRAINT IF EXISTS legal_cases_case_profile_object;
ALTER TABLE legal_cases ADD CONSTRAINT legal_cases_case_profile_object
  CHECK(case_profile IS NULL OR jsonb_typeof(case_profile)='object');
CREATE INDEX IF NOT EXISTS legal_cases_canonical_reference
  ON legal_cases((case_profile->>'canonicalCaseId'))
  WHERE case_profile ? 'canonicalCaseId';

CREATE TABLE IF NOT EXISTS legal_case_relations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_case_id integer NOT NULL REFERENCES legal_cases(id) ON DELETE RESTRICT,
  second_case_id integer NOT NULL REFERENCES legal_cases(id) ON DELETE RESTRICT,
  relation_type varchar(120) NOT NULL CHECK(length(btrim(relation_type))>0),
  evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 4000),
  source_record_ids integer[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(first_case_id,second_case_id),
  CHECK(first_case_id<second_case_id)
);
CREATE INDEX IF NOT EXISTS legal_case_relations_reverse
  ON legal_case_relations(second_case_id,first_case_id);

-- Owner-authorized one-off Arabic rendering for Ibn Hayyan market medicine cards.
-- English card names and original staged source rows remain intact.
CREATE TABLE market_card_arabization_runs (
 id uuid PRIMARY KEY,
 source_id bigint NOT NULL UNIQUE REFERENCES market_import_sources(id),
 actor_id integer NOT NULL REFERENCES users(id),
 status text NOT NULL CHECK (status IN ('running','complete','failed')),
 engine text NOT NULL DEFAULT 'phonetic-lexicon-v1',
 total integer NOT NULL DEFAULT 0,
 changed integer NOT NULL DEFAULT 0,
 original_arabic integer NOT NULL DEFAULT 0,
 remaining_latin integer NOT NULL DEFAULT 0,
 truncated integer NOT NULL DEFAULT 0,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

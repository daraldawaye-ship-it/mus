-- Import of dated Saba Pharma 18-Aug-2024 wholesale offers, kept in medicine market DB only.
CREATE TABLE market_saba_catalog_runs (
 id uuid PRIMARY KEY,
 actor_id integer NOT NULL REFERENCES users(id),
 source_sha256 char(64) NOT NULL,
 data_sha256 char(64) NOT NULL,
 status text NOT NULL CHECK(status IN ('running','complete','failed')),
 total integer NOT NULL DEFAULT 0,
 matched integer NOT NULL DEFAULT 0,
 inserted integer NOT NULL DEFAULT 0,
 changed integer NOT NULL DEFAULT 0,
 skipped integer NOT NULL DEFAULT 0,
 duplicated_offers integer NOT NULL DEFAULT 0,
 price_preserved integer NOT NULL DEFAULT 0,
 agent_preserved integer NOT NULL DEFAULT 0,
 error_code text,
 report jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX market_saba_catalog_runs_source ON market_saba_catalog_runs(source_sha256)
 WHERE status='complete';

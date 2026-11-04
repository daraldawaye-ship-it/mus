-- Private raw staging only: no cards, contributions, points or company tables.
CREATE TABLE market_import_jobs (
 id uuid PRIMARY KEY, bundle_sha256 text NOT NULL UNIQUE CHECK(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 actor_id integer NOT NULL, status text NOT NULL CHECK(status IN ('running','complete','failed')),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_import_sources (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES market_import_jobs(id),
 source_key text NOT NULL, filename text NOT NULL, drive_id text NOT NULL,
 modified_at text NOT NULL, sha256 text NOT NULL, byte_size bigint NOT NULL,
 row_count integer NOT NULL, metadata jsonb NOT NULL,
 UNIQUE(job_id,source_key), UNIQUE(drive_id,sha256)
);
CREATE TABLE market_import_chunks (
 source_id bigint NOT NULL REFERENCES market_import_sources(id) ON DELETE CASCADE,
 chunk_index integer NOT NULL, data bytea NOT NULL,
 PRIMARY KEY(source_id,chunk_index)
);
CREATE TABLE market_import_rows (
 source_id bigint NOT NULL REFERENCES market_import_sources(id) ON DELETE CASCADE,
 section text NOT NULL, position integer NOT NULL,
 payload_text text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(source_id,section,position)
);

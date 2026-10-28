-- Independent document archive: public and company records never share a scope.
CREATE TABLE archive_categories (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  name varchar(200) NOT NULL CHECK (length(btrim(name)) > 0),
  show_in_legal boolean NOT NULL DEFAULT false,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT show_in_legal OR company_id IS NULL)
);
CREATE UNIQUE INDEX archive_categories_public_name ON archive_categories(name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX archive_categories_company_name ON archive_categories(company_id,name) WHERE company_id IS NOT NULL;
CREATE INDEX archive_categories_scope ON archive_categories(company_id,id);

CREATE TABLE archive_files (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  category_id integer NOT NULL REFERENCES archive_categories(id),
  title varchar(300) NOT NULL CHECK(length(btrim(title))>0),
  original_filename varchar(255) NOT NULL DEFAULT '',
  mime_type varchar(32) NOT NULL CHECK(mime_type IN
    ('image/jpeg','image/png','image/webp','image/gif','application/pdf')),
  file_bytes bytea NOT NULL CHECK (octet_length(file_bytes) BETWEEN 1 AND 8388608),
  content_text text NOT NULL DEFAULT '',
  evidence_text text NOT NULL DEFAULT '',
  created_by integer NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX archive_files_scope_recent ON archive_files(company_id,id DESC);
CREATE INDEX archive_files_category_recent ON archive_files(category_id,id DESC);
INSERT INTO page_registry(key) VALUES ('public.archive'),('company.archive') ON CONFLICT DO NOTHING;

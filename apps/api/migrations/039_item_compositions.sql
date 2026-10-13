-- Company-scoped reusable compositions: no impact on existing item pricing,
-- inventory or posted movements. Existing items remain without a composition.
CREATE TABLE item_compositions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  arabic_name text NOT NULL CHECK (length(trim(arabic_name)) BETWEEN 1 AND 120),
  english_name text NOT NULL CHECK (length(trim(english_name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=2000),
  active boolean NOT NULL DEFAULT true,
  identical_alternative boolean NOT NULL DEFAULT false,
  non_interchangeable boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  creation_payload jsonb NOT NULL,
  CONSTRAINT composition_flags_exclusive CHECK
    (NOT(identical_alternative AND non_interchangeable)),
  UNIQUE(company_id,id),
  UNIQUE(company_id,idempotency_key)
);
CREATE INDEX item_compositions_listing ON item_compositions(company_id,active,arabic_name,id);
CREATE INDEX item_compositions_english ON item_compositions(company_id,english_name);

CREATE TRIGGER item_compositions_identity BEFORE UPDATE OR DELETE
  ON item_compositions FOR EACH ROW EXECUTE FUNCTION protect_item_master_identity();

ALTER TABLE items ADD COLUMN composition_id integer;
ALTER TABLE items ADD CONSTRAINT items_composition_fk
  FOREIGN KEY(company_id,composition_id) REFERENCES item_compositions(company_id,id);
CREATE INDEX items_composition ON items(company_id,composition_id) WHERE composition_id IS NOT NULL;

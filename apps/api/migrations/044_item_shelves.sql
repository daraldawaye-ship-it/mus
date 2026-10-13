-- Every company receives 28 Arabic shelf groups, each numbered 1–12.
-- This is additive; existing free-text item shelves and invoices are unchanged.
CREATE TABLE item_shelves (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  group_letter text NOT NULL CHECK (length(group_letter) = 1 AND group_letter IN (
    'ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي')),
  group_order smallint NOT NULL CHECK (group_order BETWEEN 1 AND 28),
  slot_number smallint NOT NULL CHECK (slot_number BETWEEN 1 AND 12),
  name text GENERATED ALWAYS AS (group_letter || '-' || slot_number::text) STORED,
  archived boolean NOT NULL DEFAULT false,
  vitrine boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,group_letter,slot_number),
  UNIQUE(company_id,group_order,slot_number),
  UNIQUE(company_id,name)
);
CREATE INDEX item_shelves_listing ON item_shelves(company_id,archived,group_order,slot_number);

-- Fixed shelf identities cannot be renamed, deleted or moved between companies;
-- modifying either option requires revision control.
CREATE FUNCTION protect_item_shelf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Archive a shelf instead of deleting it' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.company_id,NEW.group_letter,NEW.group_order,NEW.slot_number,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.company_id,OLD.group_letter,OLD.group_order,OLD.slot_number,OLD.created_by,OLD.created_at)
    OR NEW.revision <> OLD.revision+1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shelf identity is immutable and revisions are sequential' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_shelves_identity BEFORE UPDATE OR DELETE
  ON item_shelves FOR EACH ROW EXECUTE FUNCTION protect_item_shelf();

CREATE FUNCTION seed_company_shelves(p_company_id integer, p_created_by integer)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO item_shelves(company_id,group_letter,group_order,slot_number,created_by)
  SELECT p_company_id,letters.letter,letters.position::smallint,n.number::smallint,p_created_by
  FROM unnest(ARRAY['ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض',
                    'ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي'])
       WITH ORDINALITY AS letters(letter,position)
  CROSS JOIN generate_series(1,12) AS n(number)
  ON CONFLICT(company_id,group_letter,slot_number) DO NOTHING;
$$;
CREATE FUNCTION seed_new_company_shelves() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_company_shelves(NEW.id,NEW.created_by);
  RETURN NEW;
END $$;
CREATE TRIGGER companies_seed_shelves AFTER INSERT ON companies FOR EACH ROW
  EXECUTE FUNCTION seed_new_company_shelves();

-- Populate all existing companies as part of the migration. New ones are handled
-- by the trigger, without needing users to click an initialization button.
SELECT seed_company_shelves(id,created_by) FROM companies;

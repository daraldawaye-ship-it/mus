-- Company item masters only. Stock movements and invoices belong to later migrations.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (
  permissions <@ ARRAY['company.edit','employees.view','audit.view','accounts.view','accounts.manage',
  'currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.manage','finance.post',
  'items.view','items.manage']::text[]
);

CREATE TABLE item_agents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone text NOT NULL DEFAULT '' CHECK (length(phone)<=40),
  address text NOT NULL DEFAULT '' CHECK (length(address)<=500),
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=1000),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  creation_payload jsonb NOT NULL,
  UNIQUE(company_id,id),
  UNIQUE(company_id,idempotency_key)
);
CREATE INDEX item_agents_listing ON item_agents(company_id,active,id);

CREATE TABLE item_counters (
  company_id integer PRIMARY KEY REFERENCES companies(id),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 100000000)
);
CREATE TABLE items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{8}$' AND code<>'00000000'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  english_name text NOT NULL DEFAULT '' CHECK (length(english_name)<=120),
  barcode text NOT NULL DEFAULT '' CHECK (length(barcode)<=80),
  agent_id integer,
  unit1_name text NOT NULL CHECK (length(unit1_name) BETWEEN 1 AND 120),
  unit2_name text NOT NULL DEFAULT '' CHECK (length(unit2_name)<=120),
  unit3_name text NOT NULL DEFAULT '' CHECK (length(unit3_name)<=120),
  factor2 integer NOT NULL DEFAULT 1 CHECK (factor2 BETWEEN 1 AND 1000000),
  factor3 integer NOT NULL DEFAULT 1 CHECK (factor3 BETWEEN 1 AND 1000000),
  sale_price1 numeric(28,6) NOT NULL DEFAULT 0 CHECK (sale_price1>=0),
  sale_price2 numeric(28,6) NOT NULL DEFAULT 0 CHECK (sale_price2>=0),
  sale_price3 numeric(28,6) NOT NULL DEFAULT 0 CHECK (sale_price3>=0),
  purchase_price numeric(28,6) NOT NULL DEFAULT 0 CHECK (purchase_price>=0),
  purchase_factor integer NOT NULL DEFAULT 1 CHECK (purchase_factor BETWEEN 1 AND 1000000),
  currency_id integer NOT NULL,
  reorder_limit numeric(22,0) NOT NULL DEFAULT 0 CHECK (reorder_limit>=0),
  order_quantity numeric(22,0) NOT NULL DEFAULT 0 CHECK (order_quantity>=0),
  search_keys text NOT NULL DEFAULT '' CHECK (length(search_keys)<=1000),
  purchase_notes text NOT NULL DEFAULT '' CHECK (length(purchase_notes)<=1000),
  order_stopped_until date CHECK (order_stopped_until BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  has_expiry boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  creation_payload jsonb NOT NULL,
  UNIQUE(company_id,id),
  UNIQUE(company_id,code),
  UNIQUE(company_id,idempotency_key),
  CHECK (factor2=1 OR length(unit2_name)>0),
  CHECK (factor3=1 OR length(unit3_name)>0),
  FOREIGN KEY(company_id,agent_id) REFERENCES item_agents(company_id,id),
  FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id)
);
CREATE INDEX items_listing ON items(company_id,active,code);
CREATE INDEX items_agent ON items(company_id,agent_id);
CREATE INDEX items_barcode ON items(company_id,barcode) WHERE barcode<>'';

CREATE FUNCTION protect_item_master_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Item masters must be archived instead of deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.company_id,NEW.created_by,NEW.created_at,NEW.idempotency_key,NEW.creation_payload)
    IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.created_by,OLD.created_at,OLD.idempotency_key,OLD.creation_payload)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Item master identity or revision is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='items' AND (to_jsonb(NEW)->>'code') IS DISTINCT FROM (to_jsonb(OLD)->>'code') THEN
    RAISE EXCEPTION 'Item code is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_agents_identity BEFORE UPDATE OR DELETE ON item_agents FOR EACH ROW EXECUTE FUNCTION protect_item_master_identity();
CREATE TRIGGER items_identity BEFORE UPDATE OR DELETE ON items FOR EACH ROW EXECUTE FUNCTION protect_item_master_identity();

CREATE FUNCTION check_item_price_precision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE places integer;
BEGIN
  SELECT decimal_places INTO places FROM company_currencies WHERE company_id=NEW.company_id AND id=NEW.currency_id FOR SHARE;
  -- The composite foreign key reports a missing/cross-company reference.
  IF places IS NOT NULL AND (NEW.sale_price1<>round(NEW.sale_price1,places)
    OR NEW.sale_price2<>round(NEW.sale_price2,places) OR NEW.sale_price3<>round(NEW.sale_price3,places)
    OR NEW.purchase_price<>round(NEW.purchase_price,places)) THEN
    RAISE EXCEPTION 'Item prices exceed currency precision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_price_precision BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION check_item_price_precision();

-- Manual reservations are independent allocation documents, never stock movements.
-- The company-level transaction lock used by inventory mutations serializes holds and postings.
CREATE TABLE stock_reservations (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 item_id integer NOT NULL,
 location_id integer NOT NULL,
 batch_key text NOT NULL DEFAULT '',
 unit smallint NOT NULL CHECK(unit IN(1,2,3)),
 quantity_entered numeric(40,0) NOT NULL CHECK(quantity_entered>0),
 quantity_smallest numeric(40,0) NOT NULL CHECK(quantity_smallest>0),
 source_type text NOT NULL DEFAULT 'manual' CHECK(source_type='manual'),
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','released')),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 reserved_by integer NOT NULL REFERENCES users(id),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_by integer REFERENCES users(id),
 released_at timestamptz,
 release_reason text,
 release_key uuid,
 idempotency_key uuid NOT NULL,
 creation_payload jsonb NOT NULL,
 UNIQUE(company_id,id), UNIQUE(company_id,idempotency_key),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,location_id) REFERENCES locations(company_id,id),
 CHECK(batch_key='' OR batch_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 CHECK(
  (status='active' AND released_by IS NULL AND released_at IS NULL
    AND release_reason IS NULL AND release_key IS NULL)
  OR (status='released' AND released_by IS NOT NULL AND released_at IS NOT NULL
    AND release_reason IS NOT NULL AND release_key IS NOT NULL)
 )
);
CREATE UNIQUE INDEX stock_reservation_release_key
 ON stock_reservations(company_id,release_key) WHERE release_key IS NOT NULL;
CREATE INDEX stock_reservations_active_lot
 ON stock_reservations(company_id,item_id,location_id,batch_key)
 INCLUDE(quantity_smallest) WHERE status='active';
CREATE INDEX stock_reservations_item_history
 ON stock_reservations(company_id,item_id,id DESC);

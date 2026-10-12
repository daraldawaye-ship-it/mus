ALTER TABLE items ADD COLUMN legacy_id text NOT NULL DEFAULT '' CHECK(length(legacy_id)<=100);
CREATE UNIQUE INDEX items_legacy_id ON items(company_id,legacy_id) WHERE legacy_id<>'';

-- A card preference for future sales entry; historical invoice units stay unchanged.
ALTER TABLE items ADD COLUMN default_sale_unit smallint NOT NULL DEFAULT 1;
ALTER TABLE items ADD CONSTRAINT items_default_sale_unit_check CHECK (
  default_sale_unit BETWEEN 1 AND 3
  AND (default_sale_unit <> 2 OR (factor2 > 1 AND length(btrim(unit2_name)) > 0))
  AND (default_sale_unit <> 3 OR (factor3 > 1 AND length(btrim(unit3_name)) > 0))
);

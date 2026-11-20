CREATE TABLE medawee_items_staging (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  english_name text,
  arabic_name text,
  default_sale_price_old_currency numeric(18, 4),
  composition text,
  agent text,
  manufacturer text,
  completion_status text NOT NULL DEFAULT 'غير منجز'
);

COMMENT ON TABLE medawee_items_staging IS
  'Staging table for Medawee products before review and publication to the medicine market.';

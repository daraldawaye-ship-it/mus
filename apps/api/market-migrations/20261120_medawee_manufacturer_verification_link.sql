ALTER TABLE medawee_agent_manufacturers_staging
  ADD COLUMN linked_manufacturer_card_id integer,
  ADD COLUMN linked_agent_card_id integer,
  ADD CONSTRAINT medawee_staging_link_pair_check CHECK (
    (linked_manufacturer_card_id IS NULL AND linked_agent_card_id IS NULL)
    OR (manufacturer_verified AND linked_manufacturer_card_id IS NOT NULL AND linked_agent_card_id IS NOT NULL)
  );

ALTER TABLE medawee_agent_manufacturers_staging
  ADD COLUMN manufacturer_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);

COMMENT ON COLUMN medawee_agent_manufacturers_staging.manufacturer_verified IS
  'Confirms that the manufacturer card already existed or was added, independently of agent linkage and overall completion.';

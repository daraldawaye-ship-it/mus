CREATE TABLE medawee_agent_manufacturers_staging (
  agent_name text NOT NULL CHECK (btrim(agent_name) <> ''),
  manufacturer_name text NOT NULL CHECK (btrim(manufacturer_name) <> ''),
  agent_url text NOT NULL CHECK (agent_url ~ '^https://[^[:space:]]+$'),
  completion_status text NOT NULL DEFAULT 'pending'
    CHECK (completion_status IN ('pending', 'partial', 'blocked', 'complete')),
  PRIMARY KEY (agent_url, manufacturer_name)
);

COMMENT ON TABLE medawee_agent_manufacturers_staging IS
  'Working inventory of Medawee agents and manufacturers. Each pair keeps its own progress before any market card changes.';

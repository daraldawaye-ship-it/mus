-- Private descriptive metadata; deliberately separate from the users/auth DTOs.
CREATE TABLE user_site_traits (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  traits text[] NOT NULL DEFAULT ARRAY['member']::text[],
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    cardinality(traits) <= 11
    AND (cardinality(traits) = 0 OR array_ndims(traits) = 1)
    AND traits <@ ARRAY[
      'admin1','companyEmployee','editor','marketSupervisor','member','chatAllowed',
      'chatGrantor','child','legalCasesAllowed','approved','personallyKnown'
    ]::text[]
  )
);

CREATE FUNCTION init_user_site_traits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_site_traits (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_site_traits_on_create AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION init_user_site_traits();

INSERT INTO user_site_traits (user_id)
SELECT id FROM users
ON CONFLICT DO NOTHING;

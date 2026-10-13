-- Flexible platform-wide metadata records. Only platform administrators can
-- access the REST endpoints; no implicit sharing with companies or the public.
CREATE TABLE general_table (
  general_table_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  general_table_table_name varchar(120) NOT NULL CHECK (length(btrim(general_table_table_name)) > 0),
  general_table_category varchar(120) NOT NULL DEFAULT '',
  general_table_title varchar(200) NOT NULL CHECK (length(btrim(general_table_title)) > 0),
  general_table_description text NOT NULL DEFAULT '' CHECK (length(general_table_description) <= 12000),
  general_table_number1 numeric,
  general_table_number2 numeric,
  general_table_date1 timestamptz,
  general_table_date2 timestamptz,
  general_table_text1 text NOT NULL DEFAULT '' CHECK (length(general_table_text1) <= 12000),
  general_table_text2 text NOT NULL DEFAULT '' CHECK (length(general_table_text2) <= 12000),
  general_table_text3 text NOT NULL DEFAULT '' CHECK (length(general_table_text3) <= 12000),
  general_table_text4 text NOT NULL DEFAULT '' CHECK (length(general_table_text4) <= 12000),
  general_table_text5 text NOT NULL DEFAULT '' CHECK (length(general_table_text5) <= 12000),
  general_table_text6 text NOT NULL DEFAULT '' CHECK (length(general_table_text6) <= 12000),
  general_table_text7 text NOT NULL DEFAULT '' CHECK (length(general_table_text7) <= 12000),
  general_table_text8 text NOT NULL DEFAULT '' CHECK (length(general_table_text8) <= 12000),
  general_table_text9 text NOT NULL DEFAULT '' CHECK (length(general_table_text9) <= 12000),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX general_table_lookup ON general_table(general_table_table_name, general_table_category, general_table_id DESC);
CREATE INDEX general_table_recent ON general_table(updated_at DESC, general_table_id DESC);

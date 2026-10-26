
-- Hierarchical explanations for all modules, independently scoped per collection.
CREATE TABLE IF NOT EXISTS explanation_groups (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 slug varchar(120) NOT NULL UNIQUE,
 title varchar(250) NOT NULL,
 default_read jsonb,
 default_edit jsonb,
 created_by integer REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS explanation_nodes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 group_id integer NOT NULL REFERENCES explanation_groups(id) ON DELETE CASCADE,
 parent_id integer REFERENCES explanation_nodes(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position>=1),
 kind varchar(15) NOT NULL DEFAULT 'paragraph' CHECK(kind IN ('heading','paragraph')),
 title varchar(500) NOT NULL DEFAULT '',
 body text NOT NULL DEFAULT '',
 evidence text NOT NULL DEFAULT '',
 color varchar(20),
 font_size integer CHECK(font_size IS NULL OR font_size BETWEEN 10 AND 36),
 read_acl jsonb,
 edit_acl jsonb,
 import_key varchar(160) UNIQUE,
 created_by integer REFERENCES users(id),
 updated_by integer REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS explanation_nodes_tree ON explanation_nodes(group_id,parent_id,position,id);
CREATE TABLE IF NOT EXISTS explanation_assets (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 node_id integer NOT NULL REFERENCES explanation_nodes(id) ON DELETE CASCADE,
 filename varchar(250) NOT NULL,
 mime_type varchar(40) NOT NULL CHECK(mime_type IN ('application/pdf','image/png','image/jpeg','image/webp')),
 content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=2097152),
 uploaded_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS explanation_assets_node ON explanation_assets(node_id,id);
CREATE TABLE IF NOT EXISTS explanation_links (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 group_id integer NOT NULL REFERENCES explanation_groups(id) ON DELETE CASCADE,
 node_id integer REFERENCES explanation_nodes(id) ON DELETE CASCADE,
 target_type varchar(20) NOT NULL CHECK(target_type IN ('legal_case','legal_record','page')),
 target_key varchar(120) NOT NULL,
 UNIQUE(group_id,node_id,target_type,target_key)
);
CREATE INDEX IF NOT EXISTS explanation_links_target ON explanation_links(target_type,target_key);

-- Memo watchers are independent of memo workflow revisions and participants.
CREATE TABLE memo_follow_versions (
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 changed_by integer REFERENCES users(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,memo_id),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
INSERT INTO memo_follow_versions(company_id,memo_id)
 SELECT company_id,id FROM memos;

CREATE TABLE memo_followers (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 employee_id integer,
 role_id integer,
 access_level varchar(10) NOT NULL CHECK(access_level IN ('view','comment')),
 added_by integer NOT NULL REFERENCES users(id),
 added_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((employee_id IS NULL) <> (role_id IS NULL)),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,role_id) REFERENCES company_roles(company_id,id)
);
CREATE UNIQUE INDEX memo_followers_employee ON memo_followers(company_id,memo_id,employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX memo_followers_role ON memo_followers(company_id,memo_id,role_id) WHERE role_id IS NOT NULL;
CREATE INDEX memo_followers_lookup ON memo_followers(company_id,memo_id);
CREATE INDEX memo_followers_employee_lookup ON memo_followers(company_id,employee_id,memo_id) WHERE employee_id IS NOT NULL;
CREATE INDEX memo_followers_role_lookup ON memo_followers(company_id,role_id,memo_id) WHERE role_id IS NOT NULL;

CREATE TABLE memo_follow_changes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,memo_id,revision),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE TRIGGER memo_follow_changes_immutable BEFORE UPDATE OR DELETE ON memo_follow_changes
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();

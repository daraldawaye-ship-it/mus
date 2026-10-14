-- Phase one supports immutable, individually addressed company memos.
-- Registering member actions does not add grants to existing employees.
INSERT INTO page_registry(key) VALUES ('company.memos'), ('company.memo-detail');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.memos:view','company.memos','view','المذكرات — عرض','company-member','{}'),
 ('company.memos:create','company.memos','create','المذكرات — إنشاء','company-member','{}'),
 ('company.memo-detail:view','company.memo-detail','view','عرض المذكرة — عرض','company-member','{}');

CREATE TABLE memos (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '^[[:space:]]*$'),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000 AND body !~ '^[[:space:]]*$'),
 type varchar(20) NOT NULL CHECK (type IN ('task','inquiry','review','approval')),
 status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
 sender_user_id integer NOT NULL REFERENCES users(id),
 sender_name text NOT NULL,
 recipient_employee_id integer NOT NULL,
 recipient_user_id integer NOT NULL REFERENCES users(id),
 recipient_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
 UNIQUE (company_id,id),
 UNIQUE (company_id,idempotency_key),
 FOREIGN KEY (company_id,recipient_employee_id) REFERENCES employees(company_id,id)
);
CREATE INDEX memos_company_listing ON memos(company_id,created_at DESC,id DESC);
CREATE INDEX memos_received ON memos(company_id,recipient_user_id,created_at DESC,id DESC);
CREATE INDEX memos_sent ON memos(company_id,sender_user_id,created_at DESC,id DESC);

CREATE TABLE memo_events (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 kind varchar(20) NOT NULL CHECK (kind IN ('created','read')),
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE UNIQUE INDEX memo_events_created_once ON memo_events(company_id,memo_id) WHERE kind = 'created';
CREATE UNIQUE INDEX memo_events_read_once ON memo_events(company_id,memo_id,actor_user_id) WHERE kind = 'read';
CREATE INDEX memo_events_history ON memo_events(company_id,memo_id,created_at,id);

CREATE TABLE memo_reads (
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 user_id integer NOT NULL REFERENCES users(id),
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id,memo_id,user_id),
 FOREIGN KEY (company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE INDEX memo_reads_user ON memo_reads(company_id,user_id,memo_id);

CREATE FUNCTION protect_memo_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Memo identity and history are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER memos_history_immutable BEFORE UPDATE OR DELETE ON memos
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
CREATE TRIGGER memo_events_history_immutable BEFORE UPDATE OR DELETE ON memo_events
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
CREATE TRIGGER memo_reads_history_immutable BEFORE UPDATE OR DELETE ON memo_reads
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();

-- A conditional foreign key cannot target reads only. Defer this equivalent
-- scoped check so the read row and event can be inserted in either order.
CREATE FUNCTION check_memo_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind = 'created' AND NOT EXISTS (
  SELECT 1 FROM memos m
  WHERE m.company_id = NEW.company_id AND m.id = NEW.memo_id AND m.sender_user_id = NEW.actor_user_id
 ) THEN
  RAISE EXCEPTION 'A memo creation event must identify its sender' USING ERRCODE = '23514';
 END IF;
 IF NEW.kind = 'read' AND NOT EXISTS (
  SELECT 1 FROM memo_reads r
  WHERE r.company_id = NEW.company_id AND r.memo_id = NEW.memo_id AND r.user_id = NEW.actor_user_id
 ) THEN
  RAISE EXCEPTION 'A memo read event requires its scoped first-read record' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER memo_events_integrity AFTER INSERT ON memo_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memo_event_integrity();

-- Preserve existing per-company settings; only activate the code-owned type.
UPDATE notification_templates
SET implemented = true,
 description = 'عند إنشاء مذكرة جديدة موجهة إلى موظف بعينه، يصل تنبيه واحد إلى حساب المستلم داخل الشركة.',
 default_notify_managers = false
WHERE code = 'MEMO_RECEIVED';

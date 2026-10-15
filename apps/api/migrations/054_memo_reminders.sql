CREATE TABLE memo_reminder_settings (company_id integer PRIMARY KEY REFERENCES companies(id), default_time time NOT NULL DEFAULT '09:00', notify_sender boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, changed_by integer REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO memo_reminder_settings(company_id) SELECT id FROM companies;
CREATE FUNCTION memo_settings_new_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO memo_reminder_settings(company_id) VALUES(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER memo_settings_company_create AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION memo_settings_new_company();
CREATE TABLE memo_schedules (
 company_id integer NOT NULL,
 memo_id integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 active boolean NOT NULL DEFAULT true,
 due_at timestamptz NOT NULL,
 local_day date NOT NULL,
 local_time time without time zone NOT NULL,
 repeat_interval text NOT NULL DEFAULT 'none' CHECK(repeat_interval IN ('none','day','week','month')),
 assignment_revision integer NOT NULL CHECK(assignment_revision>0),
 assignee_user_id integer NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_triggered_at timestamptz,
 PRIMARY KEY(company_id,memo_id),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE INDEX memo_schedules_due ON memo_schedules(due_at,company_id,memo_id) WHERE active;
CREATE TABLE memo_schedule_history (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 memo_id integer NOT NULL,
 revision integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('scheduled','changed','cancelled','due','transition','repeated')),
 actor_user_id integer REFERENCES users(id),
 actor_name text,
 reason text NOT NULL DEFAULT '',
 due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE INDEX memo_schedule_history_search ON memo_schedule_history(company_id,memo_id,id);
CREATE TRIGGER memo_schedule_history_immutable BEFORE UPDATE OR DELETE ON memo_schedule_history
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
 VALUES('MEMO_DUE','عودة متابعة مذكرة','المذكرات','company',
 'عند حلول موعد المتابعة المؤجل؛ يعود التنبيه إلى المسؤول الحالي.',true,true,'medium',false);

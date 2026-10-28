-- Automatic tasks are defined by application code; no manual task records are created.
INSERT INTO page_registry(key) VALUES ('public.tasks'), ('company.tasks')
ON CONFLICT(key) DO NOTHING;

INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
('company.tasks:view','company.tasks','view','المهام الآلية — عرض','company-member','{}'),
('company.tasks:edit','company.tasks','edit','المهام الآلية — كنترول','company-general','{}')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE automatic_task_settings (
 company_id integer NOT NULL REFERENCES companies(id),
 task_key text NOT NULL CHECK(task_key IN ('memo_required','composition_review','stock_count')),
 enabled boolean NOT NULL DEFAULT true,
 target_count integer NOT NULL CHECK(target_count BETWEEN 1 AND 1000),
 period_days integer NOT NULL DEFAULT 1 CHECK(period_days BETWEEN 1 AND 365),
 -- Empty assigned list means all eligible employees; followers must be explicitly selected.
 assigned_employee_ids integer[] NOT NULL DEFAULT '{}',
 follower_employee_ids integer[] NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by integer REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,task_key),
 CHECK(array_position(assigned_employee_ids,NULL) IS NULL),
 CHECK(array_position(follower_employee_ids,NULL) IS NULL)
);

-- Only counts started from the due-count task AND validated as due at posting time qualify.
CREATE TABLE automatic_task_count_events (
 company_id integer NOT NULL REFERENCES companies(id),
 operation_id integer NOT NULL,
 item_id integer NOT NULL,
 actor_user_id integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,operation_id),
 FOREIGN KEY(company_id,operation_id) REFERENCES stock_operations(company_id,id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);
CREATE INDEX automatic_task_count_events_actor ON automatic_task_count_events(company_id,actor_user_id,created_at DESC);


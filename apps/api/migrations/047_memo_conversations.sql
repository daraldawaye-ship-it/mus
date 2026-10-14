-- Conversation actions retain original identity and immutable history.
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.memos:edit','company.memos','edit','المذكرات — رد وتحويل','company-member','{}');

DROP TRIGGER memos_history_immutable ON memos;
ALTER TABLE memos DROP CONSTRAINT memos_revision_check;
ALTER TABLE memos ADD CONSTRAINT memos_revision_check CHECK (revision > 0);
ALTER TABLE memos
 ADD current_user_id integer REFERENCES users(id),
 ADD current_employee_id integer,
 ADD current_name text,
 ADD current_assigned_at timestamptz DEFAULT now(),
 ADD current_assignment_revision integer NOT NULL DEFAULT 1,
 ADD FOREIGN KEY(company_id,current_employee_id) REFERENCES employees(company_id,id),
 ADD CHECK(current_assignment_revision > 0 AND current_assignment_revision <= revision);
UPDATE memos SET current_user_id=recipient_user_id,current_employee_id=recipient_employee_id,
 current_name=recipient_name,current_assigned_at=created_at;
ALTER TABLE memos ALTER current_user_id SET NOT NULL,
 ALTER current_name SET NOT NULL,ALTER current_assigned_at SET NOT NULL;
CREATE INDEX memos_current_assignee ON memos(company_id,current_user_id,created_at DESC,id DESC);

CREATE TABLE memo_participants (
 company_id integer NOT NULL REFERENCES companies(id),memo_id integer NOT NULL,
 user_id integer NOT NULL REFERENCES users(id),employee_id integer,name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,memo_id,user_id),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);
INSERT INTO memo_participants(company_id,memo_id,user_id,employee_id,name,created_at)
 SELECT m.company_id,m.id,m.sender_user_id,e.id,m.sender_name,m.created_at
 FROM memos m LEFT JOIN employees e ON e.company_id=m.company_id AND e.user_id=m.sender_user_id;
INSERT INTO memo_participants(company_id,memo_id,user_id,employee_id,name,created_at)
 SELECT company_id,id,recipient_user_id,recipient_employee_id,recipient_name,created_at FROM memos
 ON CONFLICT DO NOTHING;
CREATE INDEX memo_participants_user ON memo_participants(company_id,user_id,memo_id);
CREATE TRIGGER memo_participants_history_immutable BEFORE UPDATE OR DELETE ON memo_participants
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();

CREATE TABLE memo_assignment_reads (
 company_id integer NOT NULL REFERENCES companies(id),memo_id integer NOT NULL,
 assignment_revision integer NOT NULL CHECK(assignment_revision>0),
 user_id integer NOT NULL REFERENCES users(id),read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,memo_id,assignment_revision),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
INSERT INTO memo_assignment_reads(company_id,memo_id,assignment_revision,user_id,read_at)
 SELECT m.company_id,m.id,1,m.recipient_user_id,r.read_at FROM memos m
 JOIN memo_reads r ON r.company_id=m.company_id AND r.memo_id=m.id AND r.user_id=m.recipient_user_id;
CREATE TRIGGER memo_assignment_reads_history_immutable BEFORE UPDATE OR DELETE ON memo_assignment_reads
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();

CREATE TABLE memo_actions (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),memo_id integer NOT NULL,
 actor_user_id integer NOT NULL REFERENCES users(id),idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object'),
 result_revision integer NOT NULL CHECK(result_revision>1),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,idempotency_key),UNIQUE(company_id,memo_id,result_revision),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE TRIGGER memo_actions_history_immutable BEFORE UPDATE OR DELETE ON memo_actions
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
ALTER TABLE memo_events DROP CONSTRAINT memo_events_kind_check;
ALTER TABLE memo_events ADD CONSTRAINT memo_events_kind_check CHECK(kind IN ('created','read','reply','returned','forwarded'));
ALTER TABLE memo_events ADD body text,ADD target_user_id integer REFERENCES users(id),
 ADD target_employee_id integer,ADD target_name text,ADD assignment_revision integer,
 ADD action_id integer,
 ADD FOREIGN KEY(company_id,target_employee_id) REFERENCES employees(company_id,id),
 ADD FOREIGN KEY(company_id,action_id) REFERENCES memo_actions(company_id,id),
 ADD CHECK(assignment_revision IS NULL OR assignment_revision>0),
 ADD CHECK((kind IN ('created','read') AND body IS NULL AND action_id IS NULL AND target_user_id IS NULL AND target_employee_id IS NULL AND target_name IS NULL)
  OR (kind IN ('reply','returned','forwarded') AND body IS NOT NULL AND length(body) BETWEEN 1 AND 20000 AND body !~ '^[[:space:]]*$' AND action_id IS NOT NULL
   AND (kind='reply' OR (target_user_id IS NOT NULL AND target_name IS NOT NULL AND assignment_revision IS NOT NULL))));
DROP INDEX memo_events_read_once;
-- Existing reads were overall first reads. New assignee reads are scoped to an assignment epoch.
CREATE UNIQUE INDEX memo_events_read_once ON memo_events(company_id,memo_id,actor_user_id,COALESCE(assignment_revision,0)) WHERE kind='read';
CREATE UNIQUE INDEX memo_events_action_once ON memo_events(company_id,action_id) WHERE action_id IS NOT NULL;

CREATE FUNCTION protect_memo_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Memo identity is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','current_user_id','current_employee_id','current_name','current_assigned_at','current_assignment_revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['revision','current_user_id','current_employee_id','current_name','current_assigned_at','current_assignment_revision'])
    OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Only a revisioned memo conversation action may change responsibility' USING ERRCODE='23514';
 END IF;
 IF NEW.current_assignment_revision=OLD.current_assignment_revision THEN
  IF ROW(NEW.current_user_id,NEW.current_employee_id,NEW.current_name,NEW.current_assigned_at) IS DISTINCT FROM
     ROW(OLD.current_user_id,OLD.current_employee_id,OLD.current_name,OLD.current_assigned_at) THEN
   RAISE EXCEPTION 'Responsibility needs a new assignment revision' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.current_assignment_revision<>OLD.current_assignment_revision+1 OR NEW.current_user_id=OLD.current_user_id
    OR NEW.current_assigned_at<OLD.current_assigned_at THEN
  RAISE EXCEPTION 'Invalid memo assignment transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memos_history_immutable BEFORE UPDATE OR DELETE ON memos
 FOR EACH ROW EXECUTE FUNCTION protect_memo_conversation();

CREATE OR REPLACE FUNCTION check_memo_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action memo_actions;
BEGIN
 IF NEW.kind='created' AND NOT EXISTS(SELECT 1 FROM memos m WHERE m.company_id=NEW.company_id AND m.id=NEW.memo_id AND m.sender_user_id=NEW.actor_user_id) THEN
  RAISE EXCEPTION 'A memo creation event must identify its sender' USING ERRCODE='23514';
 END IF;
 IF NEW.kind='read' AND NOT EXISTS(SELECT 1 FROM memo_reads r WHERE r.company_id=NEW.company_id AND r.memo_id=NEW.memo_id AND r.user_id=NEW.actor_user_id)
 THEN RAISE EXCEPTION 'A memo read event requires its scoped first-read record' USING ERRCODE='23514'; END IF;
 IF NEW.kind='read' AND NEW.assignment_revision IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM memo_assignment_reads r WHERE r.company_id=NEW.company_id AND r.memo_id=NEW.memo_id AND r.user_id=NEW.actor_user_id AND r.assignment_revision=NEW.assignment_revision
 ) THEN RAISE EXCEPTION 'An assignment read needs its immutable read record' USING ERRCODE='23514'; END IF;
 IF NEW.action_id IS NOT NULL THEN
  SELECT * INTO action FROM memo_actions WHERE company_id=NEW.company_id AND id=NEW.action_id;
  IF action.memo_id<>NEW.memo_id OR action.actor_user_id<>NEW.actor_user_id OR action.request_payload->>'body'<>NEW.body
   OR NEW.kind<>(CASE action.request_payload->>'action' WHEN 'reply' THEN 'reply' WHEN 'return' THEN 'returned' WHEN 'forward' THEN 'forwarded' ELSE '' END) THEN
   RAISE EXCEPTION 'A memo action event must match its immutable request' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION check_memo_conversation_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event memo_events;
BEGIN
 SELECT e.* INTO event FROM memo_actions a JOIN memo_events e ON e.company_id=a.company_id AND e.action_id=a.id
 WHERE a.company_id=NEW.company_id AND a.memo_id=NEW.id AND a.result_revision=NEW.revision;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=NEW.company_id AND p.memo_id=NEW.id AND p.user_id=event.actor_user_id) THEN
  RAISE EXCEPTION 'Memo revision requires its participant action event' USING ERRCODE='23514';
 END IF;
 IF NEW.current_assignment_revision=OLD.current_assignment_revision THEN
  IF event.kind<>'reply' THEN RAISE EXCEPTION 'Only replies retain responsibility' USING ERRCODE='23514'; END IF;
 ELSE
  IF event.kind NOT IN ('returned','forwarded') OR event.actor_user_id<>OLD.current_user_id
   OR event.target_user_id<>NEW.current_user_id OR event.target_employee_id IS DISTINCT FROM NEW.current_employee_id
   OR event.target_name<>NEW.current_name OR event.assignment_revision<>NEW.current_assignment_revision
   OR NOT EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=NEW.company_id AND p.memo_id=NEW.id AND p.user_id=NEW.current_user_id) THEN
   RAISE EXCEPTION 'Memo responsibility must match its immutable transfer event' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER memos_conversation_integrity AFTER UPDATE ON memos
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memo_conversation_integrity();

CREATE FUNCTION check_memo_action_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE memo memos; event memo_events;
BEGIN
 SELECT * INTO memo FROM memos WHERE company_id=NEW.company_id AND id=NEW.memo_id;
 SELECT * INTO event FROM memo_events WHERE company_id=NEW.company_id AND action_id=NEW.id;
 IF NOT FOUND OR NEW.result_revision<>(NEW.request_payload->>'revision')::integer+1 OR NEW.result_revision>memo.revision
  OR (event.kind='returned' AND event.target_user_id<>memo.sender_user_id)
  OR (event.kind='forwarded' AND event.target_employee_id IS DISTINCT FROM (NEW.request_payload->>'recipientEmployeeId')::integer) THEN
  RAISE EXCEPTION 'An accepted memo action needs its matching revision and event' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER memo_actions_integrity AFTER INSERT ON memo_actions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memo_action_integrity();

UPDATE notification_templates SET implemented=true,default_notify_managers=false,
 description='رد جديد داخل المذكرة يصل إلى المرسل، أو إلى المسؤول الحالي عندما يرد المرسل، دون نقل المسؤولية.'
 WHERE code='MEMO_REPLY';

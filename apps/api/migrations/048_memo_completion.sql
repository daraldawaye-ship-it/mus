-- Sender approval closes the same memo; no generic alert may approve it.
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.memos:post','company.memos','post','المذكرات — إنجاز واعتماد','company-member','{}');
ALTER TABLE memos DROP CONSTRAINT memos_status_check;
ALTER TABLE memos ADD CONSTRAINT memos_status_check CHECK(status IN ('pending','awaiting_approval','completed'));
ALTER TABLE memos
 ADD completion_requested_by_user_id integer REFERENCES users(id),
 ADD completion_requested_by_employee_id integer,
 ADD completion_requested_by_name text,
 ADD completion_requested_at timestamptz,
 ADD completed_at timestamptz,
 ADD completed_by_user_id integer REFERENCES users(id),
 ADD completed_by_name text,
 ADD FOREIGN KEY(company_id,completion_requested_by_employee_id) REFERENCES employees(company_id,id),
 ADD CONSTRAINT memos_completion_request_check CHECK(
  (completion_requested_by_user_id IS NULL AND completion_requested_by_employee_id IS NULL AND completion_requested_by_name IS NULL AND completion_requested_at IS NULL)
  OR (completion_requested_by_user_id IS NOT NULL AND completion_requested_by_name IS NOT NULL AND completion_requested_at IS NOT NULL)),
 ADD CONSTRAINT memos_approval_state_check CHECK(
  (status='awaiting_approval' AND completion_requested_by_user_id IS NOT NULL AND completion_requested_by_user_id<>sender_user_id AND current_user_id=sender_user_id)
  OR (status='pending' AND completion_requested_by_user_id IS NULL) OR status='completed'),
 ADD CONSTRAINT memos_completed_state_check CHECK(
  (status='completed' AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL AND completed_by_user_id=sender_user_id AND completed_by_name IS NOT NULL AND current_user_id=sender_user_id)
  OR (status<>'completed' AND completed_at IS NULL AND completed_by_user_id IS NULL AND completed_by_name IS NULL));
CREATE INDEX memos_approval_queue ON memos(company_id,sender_user_id,created_at DESC,id DESC) WHERE status='awaiting_approval';

ALTER TABLE memo_events DROP CONSTRAINT memo_events_kind_check;
ALTER TABLE memo_events ADD CONSTRAINT memo_events_kind_check CHECK(kind IN ('created','read','reply','returned','forwarded','completion_requested','completed','reopened'));
ALTER TABLE memo_events DROP CONSTRAINT memo_events_check;
ALTER TABLE memo_events ADD CONSTRAINT memo_events_check CHECK(
 (kind IN ('created','read') AND body IS NULL AND action_id IS NULL AND target_user_id IS NULL AND target_employee_id IS NULL AND target_name IS NULL)
 OR (kind IN ('reply','returned','forwarded','completion_requested','completed','reopened') AND body IS NOT NULL AND length(body) BETWEEN 1 AND 20000 AND body !~ '^[[:space:]]*$' AND action_id IS NOT NULL
  AND ((kind IN ('reply','completed') AND target_user_id IS NULL AND target_employee_id IS NULL AND target_name IS NULL AND assignment_revision IS NULL)
   OR (kind IN ('returned','forwarded','completion_requested','reopened') AND target_user_id IS NOT NULL AND target_name IS NOT NULL AND assignment_revision IS NOT NULL))));

CREATE OR REPLACE FUNCTION protect_memo_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='completed' THEN RAISE EXCEPTION 'Completed memos and memo identity are immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','current_user_id','current_employee_id','current_name','current_assigned_at','current_assignment_revision','status',
   'completion_requested_by_user_id','completion_requested_by_employee_id','completion_requested_by_name','completion_requested_at','completed_at','completed_by_user_id','completed_by_name']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['revision','current_user_id','current_employee_id','current_name','current_assigned_at','current_assignment_revision','status',
   'completion_requested_by_user_id','completion_requested_by_employee_id','completion_requested_by_name','completion_requested_at','completed_at','completed_by_user_id','completed_by_name'])
    OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Only a revisioned memo action may change workflow' USING ERRCODE='23514';
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
   OR NEW.kind<>(CASE action.request_payload->>'action' WHEN 'reply' THEN 'reply' WHEN 'return' THEN 'returned' WHEN 'forward' THEN 'forwarded'
     WHEN 'request-completion' THEN 'completion_requested' WHEN 'approve-completion' THEN 'completed' WHEN 'complete' THEN 'completed'
     WHEN 'reopen-completion' THEN 'reopened' ELSE '' END) THEN
   RAISE EXCEPTION 'A memo action event must match its immutable request' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_memo_conversation_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event memo_events; action_type text;
BEGIN
 SELECT e.* INTO event FROM memo_actions a JOIN memo_events e ON e.company_id=a.company_id AND e.action_id=a.id
 WHERE a.company_id=NEW.company_id AND a.memo_id=NEW.id AND a.result_revision=NEW.revision;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=NEW.company_id AND p.memo_id=NEW.id AND p.user_id=event.actor_user_id) THEN
  RAISE EXCEPTION 'Memo revision requires its participant action event' USING ERRCODE='23514';
 END IF;
 SELECT request_payload->>'action' INTO action_type FROM memo_actions WHERE company_id=NEW.company_id AND id=event.action_id;
 IF NEW.current_assignment_revision<>OLD.current_assignment_revision THEN
  IF event.kind NOT IN ('returned','forwarded','completion_requested','reopened') OR event.actor_user_id<>OLD.current_user_id
   OR event.target_user_id<>NEW.current_user_id OR event.target_employee_id IS DISTINCT FROM NEW.current_employee_id
   OR event.target_name<>NEW.current_name OR event.assignment_revision<>NEW.current_assignment_revision
   OR NOT EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=NEW.company_id AND p.memo_id=NEW.id AND p.user_id=NEW.current_user_id) THEN
   RAISE EXCEPTION 'Memo responsibility must match its immutable transition event' USING ERRCODE='23514';
  END IF;
 ELSIF event.kind NOT IN ('reply','completed') THEN
  RAISE EXCEPTION 'This workflow action must transfer responsibility' USING ERRCODE='23514';
 END IF;
 IF event.kind='reply' THEN
  IF NEW.status<>OLD.status OR ROW(NEW.completion_requested_by_user_id,NEW.completion_requested_by_employee_id,NEW.completion_requested_by_name,NEW.completion_requested_at,NEW.completed_at,NEW.completed_by_user_id,NEW.completed_by_name)
   IS DISTINCT FROM ROW(OLD.completion_requested_by_user_id,OLD.completion_requested_by_employee_id,OLD.completion_requested_by_name,OLD.completion_requested_at,OLD.completed_at,OLD.completed_by_user_id,OLD.completed_by_name) THEN
   RAISE EXCEPTION 'A reply cannot alter completion state' USING ERRCODE='23514';
  END IF;
 ELSIF event.kind IN ('returned','forwarded') THEN
  IF OLD.status<>'pending' OR NEW.status<>'pending' THEN RAISE EXCEPTION 'Only pending memos may be forwarded' USING ERRCODE='23514'; END IF;
 ELSIF event.kind='completion_requested' THEN
  IF OLD.status<>'pending' OR NEW.status<>'awaiting_approval' OR OLD.current_user_id=OLD.sender_user_id
   OR NEW.current_user_id<>OLD.sender_user_id OR NEW.completion_requested_by_user_id<>OLD.current_user_id
   OR NEW.completion_requested_by_employee_id IS DISTINCT FROM OLD.current_employee_id
   OR NEW.completion_requested_by_name<>event.actor_name OR NEW.completion_requested_at<>event.created_at THEN
   RAISE EXCEPTION 'Completion request must come from the assignee and go to its original sender' USING ERRCODE='23514';
  END IF;
 ELSIF event.kind='reopened' THEN
  IF OLD.status<>'awaiting_approval' OR NEW.status<>'pending' OR event.actor_user_id<>OLD.sender_user_id
   OR NEW.current_user_id<>OLD.completion_requested_by_user_id OR NEW.current_employee_id IS DISTINCT FROM OLD.completion_requested_by_employee_id
   OR NEW.current_name<>OLD.completion_requested_by_name THEN
   RAISE EXCEPTION 'Only the sender may return a completion request to its requester' USING ERRCODE='23514';
  END IF;
 ELSIF event.kind='completed' THEN
  IF NEW.status<>'completed' OR event.actor_user_id<>OLD.sender_user_id OR OLD.current_user_id<>OLD.sender_user_id
   OR NEW.current_assignment_revision<>OLD.current_assignment_revision OR NEW.completed_by_user_id<>event.actor_user_id
   OR NEW.completed_by_name<>event.actor_name OR NEW.completed_at<>event.created_at
   OR (OLD.status='pending' AND action_type<>'complete') OR (OLD.status='awaiting_approval' AND action_type<>'approve-completion')
   OR ROW(NEW.completion_requested_by_user_id,NEW.completion_requested_by_employee_id,NEW.completion_requested_by_name,NEW.completion_requested_at)
     IS DISTINCT FROM ROW(OLD.completion_requested_by_user_id,OLD.completion_requested_by_employee_id,OLD.completion_requested_by_name,OLD.completion_requested_at) THEN
   RAISE EXCEPTION 'Only the original sender may approve and close a memo' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

UPDATE notification_templates SET implemented=true,default_notify_managers=false,
 description='طلب إنجاز من المسؤول الحالي في المذكرة، موجّه إلى المرسل الأصلي للمصادقة أو الإعادة للاستكمال.' WHERE code='MEMO_APPROVAL';
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers) VALUES
 ('MEMO_COMPLETED','اعتماد إنجاز مذكرة','مذكرات','company','اعتماد المرسل الأصلي لإنجاز المذكرة، وإبلاغ منفذها دون إعادة فتح التكليف.',true,true,'medium',false);

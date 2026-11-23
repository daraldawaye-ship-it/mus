-- Audited administrative closure for assigned item memos only. Ordinary workflow is unchanged.
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
     WHEN 'request-completion' THEN 'completion_requested' WHEN 'approve-completion' THEN 'completed' WHEN 'complete' THEN 'completed' WHEN 'owner-complete' THEN 'completed'
     WHEN 'reopen-completion' THEN 'reopened' ELSE '' END) THEN
   RAISE EXCEPTION 'A memo action event must match its immutable request' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_memo_conversation_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event memo_events; action_type text; owner_close boolean;
BEGIN
 SELECT e.* INTO event FROM memo_actions a JOIN memo_events e ON e.company_id=a.company_id AND e.action_id=a.id
 WHERE a.company_id=NEW.company_id AND a.memo_id=NEW.id AND a.result_revision=NEW.revision;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Memo revision requires its action event' USING ERRCODE='23514';
 END IF;
 SELECT request_payload->>'action' INTO action_type FROM memo_actions WHERE company_id=NEW.company_id AND id=event.action_id;
 owner_close := COALESCE(action_type='owner-complete' AND event.kind='completed' AND OLD.company_id=2
   AND OLD.status='pending' AND OLD.recipient_user_id IS NOT NULL AND OLD.current_user_id IS NOT NULL
   AND EXISTS(SELECT 1 FROM users u WHERE u.id=event.actor_user_id AND u.owner AND NOT u.suspended AND NOT u.archived)
   AND EXISTS(SELECT 1 FROM memo_links l WHERE l.company_id=OLD.company_id AND l.memo_id=OLD.id AND l.item_id IS NOT NULL),false);
 IF (action_type='owner-complete' AND NOT owner_close) OR (NOT owner_close AND NOT EXISTS(
   SELECT 1 FROM memo_participants p WHERE p.company_id=NEW.company_id AND p.memo_id=NEW.id AND p.user_id=event.actor_user_id)) THEN
  RAISE EXCEPTION 'Memo revision requires an authorized participant or administrative close action' USING ERRCODE='23514';
 END IF;
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
  IF NEW.status<>'completed' OR (NOT owner_close AND (event.actor_user_id IS DISTINCT FROM OLD.sender_user_id OR OLD.current_user_id IS DISTINCT FROM OLD.sender_user_id))
   OR NEW.current_assignment_revision<>OLD.current_assignment_revision OR NEW.completed_by_user_id<>event.actor_user_id
   OR NEW.completed_by_name<>event.actor_name OR NEW.completed_at<>event.created_at
   OR (OLD.status='pending' AND NOT owner_close AND action_type IS DISTINCT FROM 'complete') OR (OLD.status='awaiting_approval' AND action_type<>'approve-completion')
   OR ROW(NEW.completion_requested_by_user_id,NEW.completion_requested_by_employee_id,NEW.completion_requested_by_name,NEW.completion_requested_at)
     IS DISTINCT FROM ROW(OLD.completion_requested_by_user_id,OLD.completion_requested_by_employee_id,OLD.completion_requested_by_name,OLD.completion_requested_at) THEN
   RAISE EXCEPTION 'Only the original sender may approve and close a memo' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

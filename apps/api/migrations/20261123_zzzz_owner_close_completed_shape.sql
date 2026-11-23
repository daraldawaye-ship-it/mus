-- The deferred conversation trigger still verifies the owner, exact action and scope.
ALTER TABLE memos DROP CONSTRAINT memos_completed_state_check;
ALTER TABLE memos ADD CONSTRAINT memos_completed_state_check CHECK(
 (status='completed' AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL AND completed_by_name IS NOT NULL
  AND ((completed_by_user_id=sender_user_id AND current_user_id=sender_user_id)
    OR (company_id=2 AND recipient_user_id IS NOT NULL AND current_user_id IS NOT NULL AND completion_requested_by_user_id IS NULL)))
 OR (status<>'completed' AND completed_at IS NULL AND completed_by_user_id IS NULL AND completed_by_name IS NULL)
);

-- The exception is a transition, not a way to insert a memo as already closed.
CREATE FUNCTION reject_admin_closed_memo_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='completed' AND
     (NEW.completed_by_user_id IS DISTINCT FROM NEW.sender_user_id OR NEW.current_user_id IS DISTINCT FROM NEW.sender_user_id) THEN
  RAISE EXCEPTION 'Administrative memo closure requires an existing pending memo' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reject_admin_closed_memo_insert BEFORE INSERT ON memos
 FOR EACH ROW EXECUTE FUNCTION reject_admin_closed_memo_insert();

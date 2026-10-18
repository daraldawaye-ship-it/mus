CREATE TABLE chat_groups (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  scope_id integer GENERATED ALWAYS AS (coalesce(company_id,0)) STORED,
  client_group_id uuid NOT NULL,
  creator_id integer NOT NULL REFERENCES users(id),
  create_payload jsonb NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120 AND name=btrim(name)),
  manager_id integer NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  membership_revision integer NOT NULL DEFAULT 1 CHECK(membership_revision>0),
  last_message_id integer,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  UNIQUE(scope_id,client_group_id), UNIQUE(id,scope_id)
);
CREATE TABLE chat_group_members (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id integer NOT NULL REFERENCES chat_groups(id),
  user_id integer NOT NULL REFERENCES users(id),
  joined_after_message_id integer NOT NULL DEFAULT 0 CHECK(joined_after_message_id>=0),
  joined_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  left_at timestamptz,
  CHECK(left_at IS NULL OR left_at>=joined_at),
  UNIQUE(id,group_id,user_id)
);
CREATE UNIQUE INDEX chat_group_one_current_membership ON chat_group_members(group_id,user_id) WHERE left_at IS NULL;
CREATE INDEX chat_group_member_inbox ON chat_group_members(user_id,group_id) WHERE left_at IS NULL;
CREATE TABLE chat_group_messages (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id integer NOT NULL,
  scope_id integer NOT NULL,
  client_message_id uuid NOT NULL,
  sender_id integer NOT NULL,
  sender_membership_id integer NOT NULL,
  sender_name text NOT NULL,
  membership_revision integer NOT NULL CHECK(membership_revision>0),
  intended_membership_ids integer[] NOT NULL CHECK(cardinality(intended_membership_ids) BETWEEN 1 AND 49),
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000 AND text=btrim(text)),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  FOREIGN KEY(group_id,scope_id) REFERENCES chat_groups(id,scope_id),
  FOREIGN KEY(sender_membership_id,group_id,sender_id) REFERENCES chat_group_members(id,group_id,user_id),
  UNIQUE(scope_id,client_message_id), UNIQUE(id,group_id)
);
ALTER TABLE chat_groups ADD CONSTRAINT chat_group_last_message_fk
  FOREIGN KEY(last_message_id,id) REFERENCES chat_group_messages(id,group_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX chat_group_message_history ON chat_group_messages(group_id,id DESC);
CREATE TABLE chat_group_receipts (
  message_id integer NOT NULL,
  group_id integer NOT NULL,
  membership_id integer NOT NULL,
  user_id integer NOT NULL,
  recipient_name text NOT NULL,
  delivered_at timestamptz,
  read_at timestamptz,
  PRIMARY KEY(message_id,user_id), UNIQUE(message_id,membership_id),
  FOREIGN KEY(message_id,group_id) REFERENCES chat_group_messages(id,group_id),
  FOREIGN KEY(membership_id,group_id,user_id) REFERENCES chat_group_members(id,group_id,user_id),
  CHECK(read_at IS NULL OR (delivered_at IS NOT NULL AND read_at>=delivered_at))
);
CREATE INDEX chat_group_unread ON chat_group_receipts(membership_id,message_id) WHERE read_at IS NULL;

CREATE FUNCTION guard_chat_group_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer[]; current_revision integer;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Group message history is immutable' USING ERRCODE='23514';
  END IF;
  SELECT membership_revision INTO current_revision FROM chat_groups WHERE id=NEW.group_id FOR UPDATE;
  IF current_revision IS DISTINCT FROM NEW.membership_revision OR NOT EXISTS(
    SELECT 1 FROM chat_group_members WHERE id=NEW.sender_membership_id AND group_id=NEW.group_id
      AND user_id=NEW.sender_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid group sender or membership revision' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO expected FROM chat_group_members
    WHERE group_id=NEW.group_id AND left_at IS NULL AND user_id<>NEW.sender_id;
  IF expected IS DISTINCT FROM NEW.intended_membership_ids THEN
    RAISE EXCEPTION 'Group recipients must match send-time members' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_group_messages_immutable BEFORE INSERT OR UPDATE OR DELETE
ON chat_group_messages FOR EACH ROW EXECUTE FUNCTION guard_chat_group_message();
CREATE FUNCTION guard_chat_group_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sent chat_group_messages%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Group receipt history is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT sent FROM chat_group_messages WHERE id=NEW.message_id;
  IF TG_OP='INSERT' THEN
    IF NOT NEW.membership_id=ANY(sent.intended_membership_ids) OR
      NEW.delivered_at IS NOT NULL OR NEW.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid send-time group receipt' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['delivered_at','read_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['delivered_at','read_at']) OR
      (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) OR
      (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'First group receipt timestamps are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.delivered_at<sent.created_at THEN
    RAISE EXCEPTION 'Group receipt predates message' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_group_receipts_immutable BEFORE INSERT OR UPDATE OR DELETE
ON chat_group_receipts FOR EACH ROW EXECUTE FUNCTION guard_chat_group_receipt();
CREATE FUNCTION verify_chat_group_recipients() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer[]; actual integer[]; message_key integer;
BEGIN
  IF TG_TABLE_NAME='chat_group_messages' THEN message_key:=NEW.id;
  ELSE message_key:=NEW.message_id; END IF;
  SELECT intended_membership_ids INTO expected FROM chat_group_messages WHERE id=message_key;
  SELECT array_agg(membership_id ORDER BY membership_id) INTO actual FROM chat_group_receipts WHERE message_id=message_key;
  IF expected IS DISTINCT FROM actual THEN
    RAISE EXCEPTION 'Incomplete group recipient snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER chat_group_message_recipient_integrity AFTER INSERT
ON chat_group_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_chat_group_recipients();
CREATE CONSTRAINT TRIGGER chat_group_receipt_recipient_integrity AFTER INSERT
ON chat_group_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_chat_group_recipients();
CREATE FUNCTION guard_chat_group_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'left_at') IS DISTINCT FROM (to_jsonb(OLD)-'left_at') OR
    OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'Group membership epochs are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_group_members_immutable BEFORE UPDATE OR DELETE
ON chat_group_members FOR EACH ROW EXECUTE FUNCTION guard_chat_group_member();
CREATE FUNCTION guard_chat_group_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (to_jsonb(NEW)-ARRAY['scope_id','name','manager_id','revision','membership_revision','last_message_id','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['scope_id','name','manager_id','revision','membership_revision','last_message_id','updated_at']) OR
    NEW.revision<OLD.revision OR NEW.membership_revision<OLD.membership_revision OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Group creation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_group_identity_immutable BEFORE UPDATE OR DELETE
ON chat_groups FOR EACH ROW EXECUTE FUNCTION guard_chat_group_identity();
CREATE FUNCTION verify_chat_group_management() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_key integer; manager_key integer; total integer;
BEGIN
  IF TG_TABLE_NAME='chat_groups' THEN group_key:=NEW.id;
  ELSE group_key:=NEW.group_id; END IF;
  SELECT manager_id INTO manager_key FROM chat_groups WHERE id=group_key;
  SELECT count(*) INTO total FROM chat_group_members WHERE group_id=group_key AND left_at IS NULL;
  IF total NOT BETWEEN 1 AND 50 OR NOT EXISTS(SELECT 1 FROM chat_group_members
    WHERE group_id=group_key AND user_id=manager_key AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Group must retain its manager and bounded membership' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER chat_group_management_integrity AFTER INSERT OR UPDATE
ON chat_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_chat_group_management();
CREATE CONSTRAINT TRIGGER chat_group_members_management_integrity AFTER INSERT OR UPDATE
ON chat_group_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_chat_group_management();

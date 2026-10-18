-- Global identity chat and company chat are distinct private conversations.
INSERT INTO page_registry(key) VALUES ('public.chat'),('company.chat')
ON CONFLICT DO NOTHING;
-- Code-owned company actions must be available for current explicit denies.
-- This creates definitions only; it does not add employee or role grants.
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES
  ('company.chat:view','company.chat','view','دردشة الشركة — عرض','company-member','{}'),
  ('company.chat:create','company.chat','create','دردشة الشركة — إرسال','company-member','{}')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE chat_conversations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  scope_id integer GENERATED ALWAYS AS (coalesce(company_id,0)) STORED,
  user_low_id integer NOT NULL REFERENCES users(id),
  user_high_id integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_low_id < user_high_id),
  UNIQUE(scope_id,user_low_id,user_high_id),
  UNIQUE(id,scope_id)
);
CREATE INDEX chat_conversations_low_inbox ON chat_conversations(scope_id,user_low_id,updated_at DESC,id DESC);
CREATE INDEX chat_conversations_high_inbox ON chat_conversations(scope_id,user_high_id,updated_at DESC,id DESC);

CREATE TABLE chat_messages (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id integer NOT NULL,
  scope_id integer NOT NULL,
  client_message_id uuid NOT NULL,
  sender_id integer NOT NULL REFERENCES users(id),
  recipient_id integer NOT NULL REFERENCES users(id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000 AND text=btrim(text)),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  read_at timestamptz,
  FOREIGN KEY(conversation_id,scope_id) REFERENCES chat_conversations(id,scope_id),
  UNIQUE(scope_id,client_message_id),
  CHECK(sender_id<>recipient_id),
  CHECK(delivered_at IS NULL OR delivered_at>=created_at),
  CHECK(read_at IS NULL OR (delivered_at IS NOT NULL AND read_at>=delivered_at))
);
CREATE INDEX chat_messages_history ON chat_messages(conversation_id,id DESC);
CREATE INDEX chat_messages_unread ON chat_messages(conversation_id,recipient_id) WHERE read_at IS NULL;

-- Preserve accepted content and first server receipt timestamps permanently.
CREATE FUNCTION guard_chat_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conversation chat_conversations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Chat history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['delivered_at','read_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['delivered_at','read_at']) OR
       (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) OR
       (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
      RAISE EXCEPTION 'Chat content and first receipts are immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO STRICT conversation FROM chat_conversations WHERE id=NEW.conversation_id;
    IF least(NEW.sender_id,NEW.recipient_id)<>conversation.user_low_id OR
       greatest(NEW.sender_id,NEW.recipient_id)<>conversation.user_high_id OR
       NEW.delivered_at IS NOT NULL OR NEW.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid chat participants or initial receipts' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_message_history_guard BEFORE INSERT OR UPDATE OR DELETE
ON chat_messages FOR EACH ROW EXECUTE FUNCTION guard_chat_message();

CREATE FUNCTION guard_chat_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (to_jsonb(NEW)-ARRAY['updated_at','scope_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','scope_id']) OR
    NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Chat conversation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_conversation_identity_guard BEFORE UPDATE OR DELETE
ON chat_conversations FOR EACH ROW EXECUTE FUNCTION guard_chat_conversation();

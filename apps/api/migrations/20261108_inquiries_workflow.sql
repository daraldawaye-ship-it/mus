-- Cross-company inquiry workflow: one parent request, a snapshot of recipients,
-- and immutable replies. Public requests have company_id NULL.
INSERT INTO page_registry(key) VALUES ('public.inquiries'),('company.inquiries')
ON CONFLICT (key) DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.inquiries:view','company.inquiries','view','الاستفسارات والطلبات — عرض','company-member','{}'),
 ('company.inquiries:create','company.inquiries','create','الاستفسارات والطلبات — إضافة','company-general','{}'),
 ('company.inquiries:edit','company.inquiries','edit','الاستفسارات والطلبات — متابعة','company-general','{}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE inquiry_requests (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer REFERENCES companies(id),
 request_type text NOT NULL CHECK (request_type IN ('question','clarification','information','confirmation','execution')),
 request_text text NOT NULL CHECK (length(trim(request_text)) BETWEEN 1 AND 4000),
 answer_type text NOT NULL CHECK (answer_type IN ('number','number_note','date','yesno','choice','text')),
 answer_options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answer_options)='array'),
 response_mode text NOT NULL CHECK (response_mode IN ('first','all')),
 recipient_selection jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(recipient_selection)='object'),
 priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
 due_at timestamptz,
 linked_table text CHECK (linked_table IS NULL OR length(linked_table) BETWEEN 1 AND 120),
 linked_record_id bigint CHECK (linked_record_id IS NULL OR linked_record_id > 0),
 follow_up_action text NOT NULL DEFAULT '' CHECK (length(follow_up_action) <= 4000),
 action_result text NOT NULL DEFAULT '' CHECK (length(action_result) <= 4000),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','in_progress','done','closed')),
 created_by integer NOT NULL REFERENCES users(id),
 updated_by integer REFERENCES users(id),
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 answered_at timestamptz,
 UNIQUE (created_by,idempotency_key)
);
CREATE INDEX inquiry_requests_scope_latest ON inquiry_requests(company_id,id DESC);
CREATE INDEX inquiry_requests_linked ON inquiry_requests(linked_table,linked_record_id) WHERE linked_table IS NOT NULL;

CREATE TABLE inquiry_targets (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 inquiry_id integer NOT NULL REFERENCES inquiry_requests(id) ON DELETE RESTRICT,
 user_id integer NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','waived')),
 answered_at timestamptz,
 UNIQUE(inquiry_id,user_id)
);
CREATE INDEX inquiry_targets_user_pending ON inquiry_targets(user_id,inquiry_id) WHERE status='pending';

CREATE TABLE inquiry_answers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 inquiry_id integer NOT NULL REFERENCES inquiry_requests(id),
 target_id integer NOT NULL REFERENCES inquiry_targets(id),
 user_id integer NOT NULL REFERENCES users(id),
 answer_value text NOT NULL CHECK (length(answer_value) BETWEEN 1 AND 2000),
 option_number smallint CHECK (option_number IS NULL OR option_number BETWEEN 1 AND 4),
 explanation text NOT NULL DEFAULT '' CHECK (length(explanation)<=2000),
 idempotency_key uuid NOT NULL,
 answered_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(inquiry_id,user_id),
 UNIQUE(user_id,idempotency_key),
 UNIQUE(target_id)
);
CREATE INDEX inquiry_answers_inquiry ON inquiry_answers(inquiry_id,answered_at,id);
CREATE FUNCTION inquiry_answers_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Inquiry answer history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER inquiry_answers_no_change BEFORE UPDATE OR DELETE ON inquiry_answers
FOR EACH ROW EXECUTE FUNCTION inquiry_answers_immutable();
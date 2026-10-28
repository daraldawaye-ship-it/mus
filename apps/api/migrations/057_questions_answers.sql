-- Public questions have company_id NULL. Company questions are isolated by company_id.
INSERT INTO page_registry(key) VALUES
 ('public.questions'),('public.answers'),('company.questions'),('company.answers')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.questions:view','company.questions','view','الأسئلة — عرض','company-member','{}'),
 ('company.questions:create','company.questions','create','الأسئلة — إضافة','company-general','{}'),
 ('company.questions:edit','company.questions','edit','الأسئلة — تعديل','company-general','{}'),
 ('company.answers:view','company.answers','view','الإجابات — عرض','company-member','{}'),
 ('company.answers:create','company.answers','create','الإجابات — تسجيل','company-member','{}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE questions (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer REFERENCES companies(id),
 category text NOT NULL DEFAULT '' CHECK (length(category) <= 120),
 priority integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 100),
 question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 2000),
 answer1 text NOT NULL CHECK (length(trim(answer1)) BETWEEN 1 AND 1000),
 answer2 text NOT NULL CHECK (length(trim(answer2)) BETWEEN 1 AND 1000),
 answer3 text NOT NULL CHECK (length(trim(answer3)) BETWEEN 1 AND 1000),
 answer4 text NOT NULL CHECK (length(trim(answer4)) BETWEEN 1 AND 1000),
 correct_answer smallint NOT NULL CHECK (correct_answer BETWEEN 1 AND 4),
 points integer NOT NULL DEFAULT 1 CHECK (points BETWEEN 0 AND 100000),
 active boolean NOT NULL DEFAULT true,
 created_by integer NOT NULL REFERENCES users(id),
 updated_by integer REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_scope_priority ON questions(company_id,priority,id) WHERE active;

-- Each submission is immutable, including its optional comment and question snapshot.
-- Retries with the same user/key cannot create a second answer.
CREATE TABLE question_answers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 question_id integer NOT NULL REFERENCES questions(id),
 user_id integer NOT NULL REFERENCES users(id),
 selected_answer smallint NOT NULL CHECK (selected_answer BETWEEN 1 AND 4),
 is_correct boolean NOT NULL,
 awarded_points integer NOT NULL CHECK (awarded_points BETWEEN 0 AND 100000),
 comment text CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 2000),
 question_snapshot jsonb NOT NULL CHECK (jsonb_typeof(question_snapshot) = 'object'),
 idempotency_key uuid NOT NULL,
 answered_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX question_answers_question ON question_answers(question_id,answered_at DESC,id DESC);
CREATE INDEX question_answers_user ON question_answers(user_id,question_id,answered_at DESC);
CREATE FUNCTION protect_question_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Answer history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER question_answers_immutable BEFORE UPDATE OR DELETE ON question_answers
 FOR EACH ROW EXECUTE FUNCTION protect_question_answer();

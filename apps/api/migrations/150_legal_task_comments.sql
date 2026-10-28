-- A chronological, immutable log of user progress updates on individual legal tasks.
-- Unlike general case reports, each comment remains linked to its specific task.
CREATE TABLE legal_task_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer NOT NULL REFERENCES legal_records(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_task_comments_task_recent_idx ON legal_task_comments(task_id,created_at DESC,id DESC);

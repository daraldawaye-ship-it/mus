-- Independent legal case workspace. Original general_table rows are not altered.
CREATE TABLE legal_cases (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title varchar(250) NOT NULL CHECK (length(btrim(title))>0),
  case_number varchar(120) NOT NULL DEFAULT '',
  agency varchar(250) NOT NULL DEFAULT '',
  drive_folder_id varchar(200) NOT NULL DEFAULT '',
  drive_folder_url text NOT NULL DEFAULT '',
  stage varchar(120) NOT NULL DEFAULT '',
  status varchar(12) NOT NULL DEFAULT 'unknown' CHECK(status IN ('active','closed','unknown')),
  file_copy_status varchar(12) NOT NULL DEFAULT 'unknown' CHECK(file_copy_status IN ('unknown','yes','no','partial')),
  start_date date,
  next_hearing date,
  priority smallint NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 10),
  summary text NOT NULL DEFAULT '',
  needs_review boolean NOT NULL DEFAULT false,
  legacy_general_id integer UNIQUE REFERENCES general_table(general_table_id),
  legacy_snapshot jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_cases_priority_idx ON legal_cases(status,priority DESC,id DESC);
CREATE TABLE legal_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind varchar(20) NOT NULL CHECK(kind IN ('fact','document','event','explanation','task','report','hearing')),
  title varchar(300) NOT NULL CHECK(length(btrim(title))>0),
  body text NOT NULL DEFAULT '',
  content_text text NOT NULL DEFAULT '',
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(image_urls)='array'),
  pdf_url text NOT NULL DEFAULT '',
  drive_file_id varchar(200) NOT NULL DEFAULT '',
  drive_folder_id varchar(200) NOT NULL DEFAULT '',
  drive_folder_url text NOT NULL DEFAULT '',
  source_issuer text NOT NULL DEFAULT '',
  document_number varchar(150) NOT NULL DEFAULT '',
  record_date date,
  due_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  status varchar(40) NOT NULL DEFAULT '',
  assigned_to integer REFERENCES users(id),
  reviewed_at timestamptz,
  legacy_general_id integer UNIQUE REFERENCES general_table(general_table_id),
  legacy_snapshot jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_records_kind_idx ON legal_records(kind,sort_order,id DESC);
CREATE INDEX legal_records_due_idx ON legal_records(due_at) WHERE kind IN ('task','hearing');
CREATE TABLE legal_record_cases (
  record_id integer NOT NULL REFERENCES legal_records(id) ON DELETE RESTRICT,
  case_id integer NOT NULL REFERENCES legal_cases(id) ON DELETE RESTRICT,
  PRIMARY KEY (record_id,case_id)
);
CREATE INDEX legal_record_cases_case ON legal_record_cases(case_id,record_id);
CREATE TABLE legal_record_links (
  first_record_id integer NOT NULL REFERENCES legal_records(id) ON DELETE RESTRICT,
  second_record_id integer NOT NULL REFERENCES legal_records(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(first_record_id,second_record_id),
  CHECK(first_record_id<second_record_id)
);
CREATE INDEX legal_links_reverse ON legal_record_links(second_record_id,first_record_id);
CREATE TABLE legal_case_access (
  case_id integer NOT NULL REFERENCES legal_cases(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES users(id),
  role varchar(10) NOT NULL CHECK(role IN ('viewer','reporter','editor')),
  granted_by integer NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,user_id)
);
CREATE INDEX legal_case_access_user ON legal_case_access(user_id,case_id);
CREATE TABLE legal_document_images (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id integer NOT NULL REFERENCES legal_records(id) ON DELETE RESTRICT,
  mime_type varchar(20) NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
  image_bytes bytea NOT NULL CHECK(octet_length(image_bytes)>0 AND octet_length(image_bytes)<=2097152),
  filename varchar(250) NOT NULL DEFAULT '',
  uploaded_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_document_images_record ON legal_document_images(record_id,id);
CREATE VIEW legal_facts AS SELECT * FROM legal_records WHERE kind='fact';
CREATE VIEW legal_documents AS SELECT * FROM legal_records WHERE kind='document';
CREATE VIEW legal_timeline AS SELECT * FROM legal_records WHERE kind='event';
CREATE VIEW legal_explanations AS SELECT * FROM legal_records WHERE kind='explanation';
CREATE VIEW legal_tasks AS SELECT * FROM legal_records WHERE kind='task';
CREATE VIEW legal_reports AS SELECT * FROM legal_records WHERE kind='report';
CREATE VIEW legal_hearings AS SELECT * FROM legal_records WHERE kind='hearing';
INSERT INTO page_registry(key) VALUES ('public.legal-cases') ON CONFLICT DO NOTHING;
-- One-time non-destructive snapshot of existing cases, preserves all original
-- fields in legacy_snapshot. Unknown procedural data stays unverified.
INSERT INTO legal_cases(title,summary,priority,needs_review,legacy_general_id,legacy_snapshot,created_by,updated_by,created_at,updated_at)
SELECT g.general_table_title,g.general_table_description,
       LEAST(10,GREATEST(0,COALESCE(g.general_table_number1,0)))::smallint,
       true,g.general_table_id,to_jsonb(g),g.created_by,g.created_by,g.created_at,g.updated_at
FROM general_table g
WHERE g.general_table_table_name='قضايا مصطفى'
ON CONFLICT(legacy_general_id) DO NOTHING;
-- Legacy details remain intact in their original table; no speculative links.
INSERT INTO legal_records(kind,title,body,record_date,due_at,status,legacy_general_id,legacy_snapshot,created_by,updated_by,created_at,updated_at)
SELECT CASE g.general_table_table_name
         WHEN 'معطيات في قضية مصطفى' THEN 'fact'
         WHEN 'مستندات قضايا مصطفى' THEN 'document'
         ELSE 'task' END,
       g.general_table_title,g.general_table_description,
       CASE WHEN g.general_table_table_name='معطيات في قضية مصطفى' THEN g.general_table_date1::date ELSE NULL END,
       CASE WHEN g.general_table_table_name='مهام في قضايا مصطفى' THEN g.general_table_date1 ELSE NULL END,
       CASE WHEN g.general_table_table_name='مهام في قضايا مصطفى' THEN 'pending' ELSE '' END,
       g.general_table_id,to_jsonb(g),g.created_by,g.created_by,g.created_at,g.updated_at
FROM general_table g
WHERE g.general_table_table_name IN ('معطيات في قضية مصطفى','مستندات قضايا مصطفى','مهام في قضايا مصطفى')
ON CONFLICT(legacy_general_id) DO NOTHING;

-- Index verified Drive archive folders without moving originals.
UPDATE legal_cases AS c
SET drive_folder_id=f.folder_id,
    drive_folder_url='https://drive.google.com/drive/folders/' || f.folder_id
FROM (VALUES
 ('ناتكو','1fk6qTz3DpalyPKdhhRucGS4KWNqKFRK5'),
 ('ريمان','13STQ7NUUZHz88L9B9zJgb3io3wPBR7Q2'),
 ('برايم','1XUQiWzG9a1dwwiXxXvvATRWUBZHzgEnr'),
 ('أسام الكبسي','1xfMwUYNw2o3Y-GKOfZ-9T5O80abeKhRh'),
 ('العطاس','1ZGqIZPtAjzMN3rSm2L_7qBo6daqq-2G_'),
 ('الشهاري','1t5ZNWq9-pF3gaq7AbeOVDd_eFOLAiEd6')
) AS f(term,folder_id)
WHERE c.title ILIKE '%' || f.term || '%' AND c.drive_folder_id='';

-- Two actual Drive PDF records independently verified by Drive file IDs.
-- Text is deliberately blank until transcribed/reviewed; original files remain in place.
WITH sources(title, file_id, source_folder) AS (VALUES
 ('ناتكو.pdf','10mN8X172QJFCbRiDnZgQkAPbSv7_wJE5','1OzGxKTR0igFkPctGSa66gLv9bYKC0xg7'),
 ('ناتكو - طلب السير في إجراءات البيع.pdf','1wSD-ghZEYedhJG5CJ1RfkTSjz3bvL3mb','1OzGxKTR0igFkPctGSa66gLv9bYKC0xg7')
), new_documents AS (
 INSERT INTO legal_records(kind,title,body,pdf_url,drive_file_id,drive_folder_id,drive_folder_url,created_by,updated_by)
 SELECT 'document',s.title,'رابط ملف أصلي في Google Drive. لم يُتحقق من نص المستند بعد.',
        'https://drive.google.com/file/d/'||s.file_id||'/view',s.file_id,s.source_folder,
        'https://drive.google.com/drive/folders/'||s.source_folder,u.id,u.id
 FROM sources s CROSS JOIN users u
 WHERE u.owner
 RETURNING id
)
INSERT INTO legal_record_cases(record_id,case_id)
SELECT d.id,c.id FROM new_documents d CROSS JOIN legal_cases c
WHERE c.title ILIKE '%ناتكو%'
ON CONFLICT DO NOTHING;

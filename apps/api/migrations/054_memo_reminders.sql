CREATE TABLE memo_reminder_settings (company_id integer PRIMARY KEY REFERENCES companies(id), default_time time NOT NULL DEFAULT '09:00', notify_sender boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, changed_by integer REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO memo_reminder_settings(company_id) SELECT id FROM companies;

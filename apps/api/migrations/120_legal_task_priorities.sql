-- Explicit owner priority overrides; NULL means recalculate automatically from the latest facts.
ALTER TABLE legal_records ADD COLUMN task_priority smallint CHECK (task_priority BETWEEN 1 AND 10);
ALTER TABLE legal_records ADD COLUMN task_priority_reason text NOT NULL DEFAULT '';
CREATE INDEX legal_records_tasks_idx ON legal_records(id DESC) WHERE kind='task';

ALTER TABLE legal_records ADD COLUMN transcription_status text,
  ADD COLUMN transcription_file boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT legal_transcription_status_valid CHECK (transcription_status IS NULL OR
    (kind='document' AND transcription_status IN ('deferred','partial','covered','complete','duplicate','unknown','archived'))),
  ADD CONSTRAINT legal_transcription_file_valid CHECK (NOT transcription_file OR
    (kind='document' AND drive_file_id<>'' AND transcription_status IS NOT NULL));
CREATE UNIQUE INDEX legal_transcription_one_file ON legal_records(drive_file_id) WHERE transcription_file;
CREATE INDEX legal_transcription_totals ON legal_records(transcription_status) WHERE transcription_file;

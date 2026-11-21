CREATE TABLE medawee_item_intake_batches (
  batch_id uuid PRIMARY KEY,
  actor_id bigint NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  receipt jsonb
);

ALTER TABLE medawee_items_staging
  ADD COLUMN intake_batch_id uuid REFERENCES medawee_item_intake_batches(batch_id),
  ADD COLUMN source_evidence jsonb;

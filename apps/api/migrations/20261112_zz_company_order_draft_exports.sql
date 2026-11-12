-- Shared daily snapshots created by printing/exporting a purchase order draft.
-- One company/item/day record, preserving the first recorded quantity and stock snapshot.
CREATE TABLE IF NOT EXISTS company_order_draft_exports (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL,
  item_name TEXT NOT NULL,
  required_quantity NUMERIC(24,6),
  available_quantity NUMERIC(24,6) NOT NULL,
  export_date DATE NOT NULL,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by BIGINT NOT NULL REFERENCES users(id),
  CONSTRAINT company_order_export_unique UNIQUE(company_id,item_id,export_date),
  CONSTRAINT company_order_export_item_fk FOREIGN KEY(company_id,item_id)
    REFERENCES items(company_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS company_order_draft_exports_recent_idx
 ON company_order_draft_exports(company_id,export_date DESC,exported_at DESC,id DESC);

-- Stock-opening reconciliation checks historic stock-operation audits.
-- Without this index each inserted movement scans hundreds of thousands of audit rows.
CREATE INDEX IF NOT EXISTS audit_events_stock_operation_lookup
  ON audit_events(company_id, target_id)
  WHERE target_type = 'stockOperation';

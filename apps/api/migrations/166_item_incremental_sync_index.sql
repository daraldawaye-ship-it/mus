-- Fast, company-scoped delta scans; no inventory or accounting data changes.
CREATE INDEX IF NOT EXISTS items_company_updated_at_id_idx
  ON items(company_id, updated_at, id);

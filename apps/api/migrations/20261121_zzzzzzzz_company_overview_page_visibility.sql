-- Presentation preferences only. A saved row hides one page on one company's
-- overview; no row means shown. Existing page grants and settings are untouched.
CREATE TABLE company_overview_hidden_pages (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  page_key varchar(100) NOT NULL REFERENCES page_registry(key) ON DELETE CASCADE,
  PRIMARY KEY (company_id, page_key),
  CHECK (page_key <> 'company.pages')
);

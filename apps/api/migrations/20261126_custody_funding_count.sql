-- Old fundings predate counting and keep their original immutable rows.
ALTER TABLE administrative_custody_fundings
 ADD COLUMN counted_cash numeric(28,6),
 ADD COLUMN book_balance_before numeric(28,6),
 ADD COLUMN variance_amount numeric(28,6),
 ADD COLUMN variance_document_id integer,
 ADD CONSTRAINT custody_funding_variance_document_fk
   FOREIGN KEY (company_id,variance_document_id) REFERENCES financial_documents(company_id,id),
 ADD CONSTRAINT custody_funding_count_consistent CHECK (
   (counted_cash IS NULL AND book_balance_before IS NULL AND variance_amount IS NULL AND variance_document_id IS NULL)
   OR
   (counted_cash IS NOT NULL AND counted_cash>=0 AND book_balance_before IS NOT NULL AND variance_amount IS NOT NULL
    AND variance_amount=counted_cash-book_balance_before
    AND ((variance_amount=0 AND variance_document_id IS NULL) OR
         (variance_amount<>0 AND variance_document_id IS NOT NULL AND variance_document_id<>financial_document_id)))
 );
CREATE UNIQUE INDEX custody_funding_variance_document
 ON administrative_custody_fundings (company_id,variance_document_id) WHERE variance_document_id IS NOT NULL;

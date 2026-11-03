-- Keep currency precision and immutable history. Only line multiplication now rounds
-- after multiplying the full unit price, identically to the shared TS calculator.
DO $migration$
DECLARE source text; old_term text := 'l.gross<>l.quantity*l.unit_price';
BEGIN
 SELECT pg_get_functiondef('check_invoice_integrity()'::regprocedure) INTO source;
 IF source IS NULL OR strpos(source,old_term)=0 THEN
   RAISE EXCEPTION 'Unexpected invoice integrity function: review price rounding';
 END IF;
 EXECUTE replace(source,old_term,
   'l.gross<>round(l.quantity*l.unit_price,doc.decimal_places)');
END $migration$;

-- Add a dedicated "إرجاع صنف" memo type without changing previous memo
-- records, their immutable history, recipients, or linked item references.
-- The form still requires explicit recipient and send confirmation.
ALTER TABLE memos DROP CONSTRAINT IF EXISTS memos_type_check;
ALTER TABLE memos
  ADD CONSTRAINT memos_type_check
  CHECK (type IN ('task','inquiry','review','approval','item_return'));

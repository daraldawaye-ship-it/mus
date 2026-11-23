-- Preserve existing memo types and allow item shortage and general item reports.
ALTER TABLE memos DROP CONSTRAINT memos_type_check;
ALTER TABLE memos ADD CONSTRAINT memos_type_check
  CHECK (type IN ('task','inquiry','review','approval','item_return','item_shortage','general'));

-- Memo references are separate from workflow status, executor and approval.
CREATE TABLE memo_links (
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 follow_page_key varchar(100) REFERENCES page_registry(key),
 follow_record_id integer CHECK(follow_record_id>0),
 reference_page_key varchar(100) REFERENCES page_registry(key),
 reference_record_id integer CHECK(reference_record_id>0),
 item_id integer,
 account_id integer,
 updated_by integer REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,memo_id),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
 CHECK(follow_page_key IS NOT NULL OR follow_record_id IS NULL),
 CHECK(reference_page_key IS NOT NULL OR reference_record_id IS NULL)
);
INSERT INTO memo_links(company_id,memo_id) SELECT company_id,id FROM memos;
CREATE INDEX memo_links_item_search ON memo_links(company_id,item_id) WHERE item_id IS NOT NULL;
CREATE INDEX memo_links_account_search ON memo_links(company_id,account_id) WHERE account_id IS NOT NULL;

CREATE TABLE memo_link_changes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 previous_value jsonb NOT NULL,
 next_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,memo_id,revision),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE TRIGGER memo_link_changes_immutable BEFORE UPDATE OR DELETE ON memo_link_changes
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
CREATE FUNCTION guard_memo_link_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Memo links cannot be deleted' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.company_id,NEW.memo_id) IS DISTINCT FROM ROW(OLD.company_id,OLD.memo_id)
  OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Memo link identity or revision is invalid' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM memos WHERE company_id=NEW.company_id AND id=NEW.memo_id AND status='completed')
 THEN RAISE EXCEPTION 'Completed memo links are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memo_links_identity BEFORE UPDATE OR DELETE ON memo_links
 FOR EACH ROW EXECUTE FUNCTION guard_memo_link_identity();

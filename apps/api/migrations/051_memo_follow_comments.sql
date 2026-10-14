-- Immutable follower notes do not change memo responsibility or workflow revision.
CREATE TABLE memo_follow_comments(
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000 AND body !~ '^[[:space:]]*$'),
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,idempotency_key),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE INDEX memo_follow_comments_history ON memo_follow_comments(company_id,memo_id,created_at,id);
CREATE TRIGGER memo_follow_comments_immutable BEFORE UPDATE OR DELETE ON memo_follow_comments
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
 VALUES('MEMO_FOLLOW','تحديث مذكرة تتابعها','مذكرات','company','إضافة متابع أو تعديل متابعة أو وصول تعليق/تغيير مهم إلى مذكرة مسموح بالاطلاع عليها.',true,true,'medium',false);

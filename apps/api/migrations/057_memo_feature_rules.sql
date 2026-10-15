INSERT INTO page_registry(key) VALUES('company.memo-feature-rules');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
 VALUES('company.memo-feature-rules:view','company.memo-feature-rules','view','قواعد ميزات المذكرات — عرض','company-general','{}'),
       ('company.memo-feature-rules:edit','company.memo-feature-rules','edit','قواعد ميزات المذكرات — تعديل','company-general','{}');
CREATE TABLE memo_feature_rules (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 name varchar(200) NOT NULL CHECK(length(trim(name))>0),
 enabled boolean NOT NULL DEFAULT false,
 employee_ids integer[] NOT NULL DEFAULT '{}',
 role_ids integer[] NOT NULL DEFAULT '{}',
 action_code text NOT NULL CHECK(action_code IN('invoice.sale.create','invoice.purchase.create')),
 effect text NOT NULL DEFAULT 'monitor' CHECK(effect IN('monitor','warn','block')),
 minimum_count integer CHECK(minimum_count>0 AND minimum_count<=100000),
 minimum_hours numeric(12,2) CHECK(minimum_hours>=0 AND minimum_hours<=100000),
 match_mode text NOT NULL DEFAULT 'all' CHECK(match_mode IN('all','any')),
 exclude_deferred_until_due boolean NOT NULL DEFAULT true,
 message text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by integer NOT NULL REFERENCES users(id),
 changed_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),
 CHECK(minimum_count IS NOT NULL OR minimum_hours IS NOT NULL)
);
CREATE INDEX memo_feature_rules_enabled ON memo_feature_rules(company_id,action_code) WHERE enabled;
CREATE TABLE memo_feature_rule_changes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 rule_id integer NOT NULL,
 revision integer NOT NULL,
 actor_user_id integer NOT NULL REFERENCES users(id),
 previous_value jsonb,
 next_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,rule_id) REFERENCES memo_feature_rules(company_id,id),
 UNIQUE(company_id,rule_id,revision)
);
CREATE TRIGGER memo_feature_rule_changes_immutable BEFORE UPDATE OR DELETE ON memo_feature_rule_changes
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();

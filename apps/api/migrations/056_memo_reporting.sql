-- Memo reports are read-only and use the same company/page grants as memo details.
INSERT INTO page_registry(key) VALUES('company.memo-report');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
 VALUES('company.memo-report:view','company.memo-report','view','تقرير المذكرات — عرض','company-member','{}');
CREATE INDEX memo_report_assignment ON memos(company_id,current_employee_id,status,current_assigned_at);
CREATE INDEX memo_report_creator ON memos(company_id,sender_user_id,created_at);
CREATE INDEX memo_report_completed ON memos(company_id,completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX memo_report_events ON memo_events(company_id,memo_id,created_at,id)
 WHERE kind IN ('created','forwarded','returned','completion_requested','reopened');

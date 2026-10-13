-- Main-list option metadata and batch value reads, without modifying any values.
CREATE INDEX option_definitions_list ON option_definitions(company_id,record_kind,sort_order,id)
  WHERE active AND (show_in_list OR searchable);
CREATE INDEX option_values_item_list ON option_values(company_id,item_id,definition_id)
  WHERE item_id IS NOT NULL;
CREATE INDEX option_values_account_list ON option_values(company_id,account_id,definition_id)
  WHERE account_id IS NOT NULL;

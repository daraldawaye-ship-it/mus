import type {PoolClient} from "pg";
import type {OptionDefinition,MemoOptionValueInput,MemoOptionValue,User} from "../../../../packages/contracts/src/index.ts";
import {HttpError} from "../errors.ts";

export const memoOptionSelect = `SELECT id,key,page_key AS "pageKey",record_kind AS "recordKind",
 name,description,value_type AS "valueType",default_value AS "defaultValue",choices,required,
 searchable,show_on_card AS "showOnCard",show_in_list AS "showInList",
 sort_order AS "sortOrder",active,is_system AS system,native_binding AS "nativeBinding",revision
 FROM option_definitions`;

export async function definitionsForMemo(client:PoolClient, companyId:number, lock=false) {
 const result=await client.query(
   `${memoOptionSelect} WHERE company_id=$1 AND record_kind='memo' AND page_key='company.memos'
     ORDER BY sort_order,id ${lock?"FOR SHARE":""}`,[companyId]);
 return result.rows as OptionDefinition[];
}
export async function validateMemoOptionEntries(
 client:PoolClient,companyId:number,entries:MemoOptionValueInput[],
 defaults:boolean,
):Promise<MemoOptionValue[]> {
 const defs=(await definitionsForMemo(client,companyId,true)).filter(d=>d.active);
 const map=new Map<number,MemoOptionValueInput>();
 for(const entry of entries){
   if(map.has(entry.definitionId))throw new HttpError(400,"duplicate_option","لا يمكن تكرار نفس الخاصية");
   map.set(entry.definitionId,entry);
 }
 for(const id of map.keys())if(!defs.some(d=>d.id===id))
   throw new HttpError(400,"invalid_option","الخاصية غير فعالة أو لا تنتمي إلى الشركة");
 const values:MemoOptionValue[]=[];
 for(const definition of defs){
   const chosen=map.get(definition.id);
   if(!defaults && !chosen)continue;
   const value=chosen?chosen.value:definition.defaultValue;
   const validated=(await client.query(
     "SELECT option_value_valid($1::text,$2::jsonb,$3::jsonb) AS valid",
     [definition.valueType,JSON.stringify(value),JSON.stringify(definition.choices)],
   )).rows[0].valid;
   if(!validated || (definition.required && (value===null || value==="")))
     throw new HttpError(400,"invalid_option_value",`قيمة غير صالحة للخيار: ${definition.name}`);
   values.push({definitionId:definition.id,value});
 }
 return values;
}
export async function saveMemoOptionValues(
 client:PoolClient,user:User,companyId:number,memoId:number,entries:MemoOptionValue[],
){
 for(const entry of entries){
   const before=(await client.query(
     "SELECT id,revision FROM option_values WHERE company_id=$1 AND memo_id=$2 AND definition_id=$3 FOR UPDATE",
     [companyId,memoId,entry.definitionId]
   )).rows[0];
   if(before)
     await client.query(
       "UPDATE option_values SET value=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=clock_timestamp() WHERE id=$3",
       [JSON.stringify(entry.value),user.id,before.id],
     );
   else await client.query(
     `INSERT INTO option_values(company_id,definition_id,record_kind,memo_id,value,created_by,updated_by)
       VALUES($1,$2,'memo',$3,$4::jsonb,$5,$5)`,
     [companyId,entry.definitionId,memoId,JSON.stringify(entry.value),user.id],
   );
 }
}
export async function memoOptionDetails(client:PoolClient,companyId:number,memoId:number) {
 const [definitions,stored,version,changes]=await Promise.all([
  definitionsForMemo(client,companyId),
  client.query("SELECT definition_id AS \"definitionId\",value FROM option_values WHERE company_id=$1 AND memo_id=$2 ORDER BY definition_id",
    [companyId,memoId]),
  client.query("SELECT revision FROM memo_option_versions WHERE company_id=$1 AND memo_id=$2",
    [companyId,memoId]),
  client.query("SELECT revision,actor_name,created_at FROM memo_option_changes WHERE company_id=$1 AND memo_id=$2 ORDER BY revision,id",
    [companyId,memoId]),
 ]);
 return {
  optionDefinitions:definitions.filter(d=>d.active || stored.rows.some(s=>s.definitionId===d.id)),
  optionValues:stored.rows.map(s=>({definitionId:s.definitionId,value:s.value as string|boolean|null})),
  optionRevision:version.rows[0]?.revision??1,
  optionChanges:changes.rows.map(s=>({revision:s.revision,actorName:s.actor_name,createdAt:s.created_at.toISOString()})),
 };
}

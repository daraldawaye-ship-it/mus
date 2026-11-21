import type {Database} from "../db.ts";
import {pageByKey} from "../../../../packages/contracts/src/index.ts";

export type PageVisitPeriod="all"|"30"|"90";
export const pageVisitRankingSql=`
  WITH ranked AS (
    SELECT p.after_value->>'pageKey' AS "pageKey", count(*) AS visits
    FROM audit_events p
    WHERE p.action='page.open' AND p.target_type='page'
      AND ((p.scope='public' AND p.company_id IS NULL AND p.after_value->>'pageKey' ~ '^public\\.[a-z][a-z-]*$') OR
           (p.scope='company' AND p.company_id IS NOT NULL AND p.after_value->>'pageKey' ~ '^company\\.[a-z][a-z-]*$'))
      AND ($1::int IS NULL OR p.actor_id=$1)
      AND ($2::int IS NULL OR p.created_at >= now() - make_interval(days => $2))
    GROUP BY p.after_value->>'pageKey'
  ), numbered AS (
    SELECT "pageKey",visits, row_number() OVER (ORDER BY visits DESC,"pageKey" ASC) AS position,
      count(*) OVER() AS total FROM ranked
  )
  SELECT "pageKey",visits::text,position::int,total::int FROM numbered
  ORDER BY position LIMIT $3 OFFSET $4`;
export async function readPageVisitStatistics(db:Database,userId:number|undefined,period:PageVisitPeriod,page:number,pageSize:number){
  const result=await db.query<{pageKey:string;visits:string;position:number;total:number}>(
    pageVisitRankingSql,[userId??null,period==="all"?null:Number(period),pageSize,(page-1)*pageSize]);
  return {
    items:result.rows.map(row=>{
      const definition=pageByKey(row.pageKey);
      return { pageKey:row.pageKey,name:definition?.name??row.pageKey,scope:row.pageKey.startsWith("company.")?"company":"public",
        visits:row.visits,position:row.position };
    }), page,pageSize,total:result.rows[0]?.total??0,
  };
}
export async function searchPageVisitUsers(db:Database,q:string){
  const pattern="%"+q.replace(/[\\%_]/g,character=>"\\"+character)+"%";
  const result=await db.query<{id:number;name:string}>(`
    SELECT id,COALESCE(NULLIF(btrim(display_name),''),name) AS name
    FROM users
    WHERE display_name ILIKE $1 OR name ILIKE $1
    ORDER BY CASE WHEN lower(btrim(display_name))=lower($2) OR lower(btrim(name))=lower($2) THEN 0 ELSE 1 END,
      name,id LIMIT 15
  `,[pattern,q]);
  return {items:result.rows};
}

import type { Pool, PoolClient } from "pg";

export const hiddenInquiryDailyLimit=5;
export function hiddenInquiryGroup(linkedTable:string|null,linkedRecordId:number|null) {
  return linkedRecordId===429 && (linkedTable==="مهام الذكاء الاصطناعي"||linkedTable==="ai_tasks")
    ? "pharmacist-item-match" : "ordinary";
}
export async function lockHiddenInquiries(db:PoolClient,companyId:number) {
  await db.query("SELECT pg_advisory_xact_lock(672518, $1::integer)",[companyId]);
}
export async function hiddenInquiryQuota(db:Pool|PoolClient,companyId:number) {
  const q=await db.query<{day:string;released:number;matched:number}>(
    `WITH day AS (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date AS d)
     SELECT day.d::text AS day,
       (SELECT count(*)::integer FROM inquiry_hidden_queue WHERE company_id=$1 AND released_day=day.d) AS released,
       (SELECT count(*)::integer FROM inquiry_requests WHERE company_id=$1 AND status='open'
        AND linked_record_id=429 AND linked_table IN ('مهام الذكاء الاصطناعي','ai_tasks')) AS matched
     FROM day`,[companyId]);
  const {day,released,matched}=q.rows[0]!;
  return {day,releasedToday:released,remainingToday:Math.max(0,hiddenInquiryDailyLimit-released),
    pharmacistRemaining:Math.max(0,5-matched)};
}

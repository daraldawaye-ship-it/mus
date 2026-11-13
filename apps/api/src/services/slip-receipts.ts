import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { SlipReceiptInput, SlipReceiptResult } from "../../../../packages/contracts/src/slip-receipts.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";

const pendingWhere = `t.company_id=$1 AND t.expense_kind='slips'
  AND NOT EXISTS(SELECT 1 FROM slip_receipt_sources s WHERE s.company_id=t.company_id AND s.source_id=t.id)`;
export async function pendingSlips(client: PoolClient, companyId: number) {
  return (await client.query(`SELECT count(*)::int AS count,COALESCE(sum(t.slip_count),0)::text AS total
    FROM administrative_custody_transfers t WHERE ${pendingWhere}`, [companyId])).rows[0] as {count:number;total:string};
}
export async function receiveSlips(client: PoolClient, companyId: number, user: User, input: SlipReceiptInput): Promise<SlipReceiptResult> {
  // Same company lock as custody transfers: no source can appear halfway
  // through counting, and different cashiers cannot settle the same sources.
  await client.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [companyId]);
  const payload=JSON.stringify(input);
  const previous=(await client.query(`SELECT id,expected_count::text AS expected,received_count::text AS received,
    difference_count::text AS difference,created_by,request_payload=$3::jsonb AS same
    FROM slip_receipts WHERE company_id=$1 AND idempotency_key=$2`,[companyId,input.idempotencyKey,payload])).rows[0];
  if(previous) {
    if(previous.created_by!==user.id || !previous.same)
      throw new HttpError(409,"slip_key_conflict","هذا الطلب مستخدم لاستلام آخر");
    return {id:previous.id,expected:previous.expected,received:previous.received,difference:previous.difference};
  }
  const pending=await pendingSlips(client,companyId);
  if(!pending.count) throw new HttpError(409,"no_pending_slips","لا توجد قصاصات مرحلة لم تُطابق بعد؛ حدّث القائمة");
  const saved=(await client.query(`INSERT INTO slip_receipts(company_id,expected_count,received_count,created_by,receiver_name,idempotency_key,request_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,expected_count::text AS expected,received_count::text AS received,difference_count::text AS difference`,
    [companyId,pending.total,input.count,user.id,user.displayName,input.idempotencyKey,payload])).rows[0] as SlipReceiptResult;
  await client.query(`INSERT INTO slip_receipt_sources(company_id,source_id,receipt_id)
    SELECT t.company_id,t.id,$2 FROM administrative_custody_transfers t WHERE ${pendingWhere}`,[companyId,saved.id]);
  await audit(client,user,"slips.receive","slip-receipt",saved.id,null,{...saved,sourceCount:pending.count},companyId);
  return saved;
}

// Three movements balance each batch: +expected, -received, +(received-expected).
// A shortage is negative and an overage positive, leaving no carry into the next count.
export async function listSlipMovements(client: PoolClient, companyId: number, limit: number, offset: number) {
  const events=`WITH events AS (
    SELECT 't:'||t.id AS id,t.created_at,0 AS ordinal,t.id AS source_id,'transfer'::text AS kind,
      COALESCE(u.display_name,'') AS actor,
      'ترحيل قصاصات — '||t.doctor_name AS description,t.slip_count::bigint AS quantity
    FROM administrative_custody_transfers t LEFT JOIN users u ON u.id=t.created_by
    WHERE t.company_id=$1 AND t.expense_kind='slips'
    UNION ALL
    SELECT 'r:'||r.id,r.created_at,1,r.id,'receipt',r.receiver_name,'استلام القصاصات',-r.received_count
    FROM slip_receipts r WHERE r.company_id=$1
    UNION ALL
    SELECT 'v:'||r.id,r.created_at,2,r.id,'variance',r.receiver_name,
      CASE WHEN r.difference_count<0 THEN 'فارق — نقص' ELSE 'فارق — زيادة' END,r.difference_count
    FROM slip_receipts r WHERE r.company_id=$1 AND r.difference_count<>0
  )`;
  const summary=(await client.query(`${events} SELECT count(*)::int AS total,
    COALESCE(sum(quantity) FILTER(WHERE kind='transfer'),0)::text AS transferred,
    COALESCE(-sum(quantity) FILTER(WHERE kind='receipt'),0)::text AS received,
    COALESCE(-sum(quantity) FILTER(WHERE kind='variance' AND quantity<0),0)::text AS shortage,
    COALESCE(sum(quantity) FILTER(WHERE kind='variance' AND quantity>0),0)::text AS surplus,
    COALESCE(sum(quantity),0)::text AS balance FROM events`,[companyId])).rows[0];
  const rows=await client.query(`${events}, ledger AS (
    SELECT *,sum(quantity) OVER(ORDER BY created_at,ordinal,source_id ROWS UNBOUNDED PRECEDING)::text AS balance FROM events
  ) SELECT id,kind,created_at AS "createdAt",actor,description,
    GREATEST(quantity,0)::text AS positive,GREATEST(-quantity,0)::text AS negative,balance
    FROM ledger ORDER BY created_at DESC,ordinal DESC,source_id DESC LIMIT $2 OFFSET $3`,[companyId,limit,offset]);
  const {total,...totals}=summary;
  return {items:rows.rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()})),total,
    page:Math.floor(offset/limit)+1,pageSize:limit,totals,pending:await pendingSlips(client,companyId)};
}

import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { ExpectedCard, ExpectedCardCreate, ExpectedCardLifecycle, ExpectedMovement, ExpectedMovementPatch } from "../../../../packages/contracts/src/expected.ts";
import { expectedDateSchema, expectedEndDateLimit } from "../../../../packages/contracts/src/expected.ts";
import { transaction, type Database } from "../db.ts";
import { HttpError, missing } from "../errors.ts";
import { audit } from "./audit.ts";
import { listQuery, searchPattern } from "./lists.ts";
import { conflict } from "./masters.ts";

const dayMilliseconds = 86_400_000;
export function expectedAdenDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year").padStart(4,"0")}-${value("month")}-${value("day")}`;
}
export function expectedNextMidnight(now = new Date()): number {
  return Date.parse(`${expectedAdenDate(now)}T00:00:00+03:00`) + dayMilliseconds;
}
async function databaseToday(db: Database): Promise<string> {
  return (await db.query<{today:string}>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today")).rows[0].today;
}
function invalid(message: string): never { throw new HttpError(400,"invalid_expected",message); }

/** Calendar dates only: every occurrence is generated at creation, including both endpoints. */
export function expectedOccurrenceDates(input: ExpectedCardCreate, fallbackStartDate: string): string[] {
  const startDate = input.startDate ?? fallbackStartDate;
  expectedDateSchema.parse(startDate);
  if (input.endDate < startDate) invalid("تاريخ انتهاء الكرت يسبق تاريخ البداية");
  if (input.endDate > expectedEndDateLimit(startDate)) invalid("ينتهي بعد لا يتجاوز ستة أشهر من يبدأ من");
  if (input.recurrence === "once") {
    if (!input.onceDate || input.onceDate < startDate || input.onceDate > input.endDate)
      invalid("حدد تاريخًا من تاريخ البداية إلى تاريخ انتهاء الكرت");
    return [input.onceDate];
  }
  const start = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${input.endDate}T00:00:00Z`);
  const result: string[] = [];
  const append = (value: number) => {
    result.push(new Date(value).toISOString().slice(0,10));
  };
  if (input.recurrence === "monthly") {
    if (input.monthDay === undefined) invalid("حدد رقم اليوم الشهري");
    const cursor = new Date(`${startDate.slice(0,7)}-01T00:00:00Z`);
    while (cursor.getTime() <= end) {
      const candidate = new Date(cursor);
      candidate.setUTCDate(input.monthDay);
      // A day that does not exist in a month is skipped, never shifted to another date.
      if (candidate.getUTCMonth() === cursor.getUTCMonth() && candidate.getTime() >= start && candidate.getTime() <= end)
        append(candidate.getTime());
      cursor.setUTCMonth(cursor.getUTCMonth()+1);
    }
  } else {
    const step = input.recurrence === "weekly" ? 7 : 1;
    if (input.recurrence === "weekly" && input.weekday === undefined) invalid("حدد يوم الأسبوع");
    const shift = input.recurrence === "weekly" ? (input.weekday! - new Date(start).getUTCDay() + 7) % 7 : 0;
    for (let value = start + shift*dayMilliseconds; value <= end; value += step*dayMilliseconds) append(value);
  }
  if (!result.length) invalid("لا يوجد موعد يوافق هذا التحديد حتى تاريخ انتهاء الكرت");
  return result;
}

const timestamp = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const cardSelect = `SELECT c.*,a.name AS account_name,a.code AS account_code,
  cashbox.name AS cash_account_name,cashbox.code AS cash_account_code,
  c.start_date::text AS start_day,c.end_date::text AS end_day,c.once_date::text AS once_day,
  c.amount::text AS exact_amount,
  stats.movement_count,stats.pending_count,stats.completed_count,stats.archived_count
  FROM expected_cards c JOIN accounts a ON (a.company_id,a.id)=(c.company_id,c.account_id)
  LEFT JOIN accounts cashbox ON (cashbox.company_id,cashbox.id)=(c.company_id,c.cash_account_id)
  CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE m.archived_at IS NULL)::integer AS movement_count,
    count(*) FILTER (WHERE m.status='pending' AND m.archived_at IS NULL)::integer AS pending_count,
    count(*) FILTER (WHERE m.archived_at IS NOT NULL)::integer AS archived_count,
    count(*) FILTER (WHERE m.status='completed')::integer AS completed_count
    FROM expected_movements m WHERE (m.company_id,m.card_id)=(c.company_id,c.id)) stats`;
const movementSelect = `SELECT m.*,c.account_id,a.name AS account_name,a.code AS account_code,c.section,c.currency_code,c.archived_at AS card_archived_at,
  c.amount::text AS original_amount,c.description AS original_description,c.expiry_mode,
  m.movement_date::text AS movement_day,m.original_date::text AS original_day,
  m.amount::text AS exact_amount,m.completed_amount::text AS exact_completed_amount
  FROM expected_movements m JOIN expected_cards c ON (c.company_id,c.id)=(m.company_id,m.card_id)
  JOIN accounts a ON (a.company_id,a.id)=(c.company_id,c.account_id)`;
function cardDTO(row: QueryResultRow): ExpectedCard {
  return {id:row.id,companyId:row.company_id,accountId:row.account_id,accountName:row.account_name,accountCode:row.account_code,
    cashAccountId:row.cash_account_id,cashAccountName:row.cash_account_name,cashAccountCode:row.cash_account_code,
    section:row.section,currencyCode:row.currency_code,amount:row.exact_amount,description:row.description,
    recurrence:row.recurrence,weekday:row.weekday,monthDay:row.month_day,onceDate:row.once_day,startDate:row.start_day,endDate:row.end_day,
    expiryMode:row.expiry_mode,movementCount:row.movement_count,pendingCount:row.pending_count,completedCount:row.completed_count,
    archivedAt:timestamp(row.archived_at),lifecycleRevision:row.lifecycle_revision,archivedMovementCount:row.archived_count,purgedMovementCount:row.purged_movement_count,
    createdAt:timestamp(row.created_at)!,createdById:row.created_by,createdByName:row.created_by_name};
}
function movementDTO(row: QueryResultRow): ExpectedMovement {
  return {id:row.id,companyId:row.company_id,cardId:row.card_id,accountId:row.account_id,accountName:row.account_name,accountCode:row.account_code,
    section:row.section,currencyCode:row.currency_code,date:row.movement_day,originalDate:row.original_day,amount:row.exact_amount,
    description:row.description,status:row.status,completedAmount:row.exact_completed_amount,completedAt:timestamp(row.completed_at),
    completionSource:row.completion_source,revision:row.revision,originalAmount:row.original_amount,originalDescription:row.original_description,
    expiryMode:row.expiry_mode,updatedAt:timestamp(row.updated_at)!,postedById:row.posted_by,postedByName:row.posted_by_name,postedAt:timestamp(row.posted_at)!,
    completedById:row.completed_by,completedByName:row.completed_by_name,cardArchived:row.card_archived_at!==null};
}
export async function readExpectedCard(db: Database, companyId: number, cardId: number): Promise<ExpectedCard> {
  const row = (await db.query(`${cardSelect} WHERE c.company_id=$1 AND c.id=$2`,[companyId,cardId])).rows[0];
  if (!row) missing("كرت المتوقع غير موجود");
  return cardDTO(row);
}
export async function readExpectedMovement(db: Database, companyId: number, movementId: number): Promise<ExpectedMovement> {
  const row = (await db.query(`${movementSelect} WHERE m.company_id=$1 AND m.id=$2 AND m.archived_at IS NULL`,[companyId,movementId])).rows[0];
  if (!row) missing("حركة المتوقع غير موجودة");
  return movementDTO(row);
}
export async function createExpectedCard(client: PoolClient, user: User, companyId: number, input: ExpectedCardCreate, today?: string): Promise<{card:ExpectedCard;created:boolean}> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`expected-card:${companyId}:${input.idempotencyKey}`]);
  const payload = JSON.stringify(input);
  // The first deployed version had no cashAccountId property. Missing and null
  // are the same optional choice, without rewriting any historical payload.
  const existing = (await client.query(`SELECT id,
    ('{"cashAccountId":null}'::jsonb || creation_payload)=('{"cashAccountId":null}'::jsonb || $3::jsonb) AS same
    FROM expected_cards WHERE company_id=$1 AND idempotency_key=$2`,[companyId,input.idempotencyKey,payload])).rows[0];
  if (existing) {
    if (!existing.same) conflict("استُخدم مفتاح الحفظ لبيانات مختلفة؛ راجع الكرت السابق");
    return {card:await readExpectedCard(client,companyId,existing.id),created:false};
  }
  const startDate = input.startDate ?? today ?? await databaseToday(client);
  const dates = expectedOccurrenceDates(input,startDate);
  const account = (await client.query(`SELECT a.id,COALESCE((SELECT cu.code FROM finance_settings f
    JOIN company_currencies cu ON (cu.company_id,cu.id)=(f.company_id,f.base_currency_id)
    WHERE f.company_id=a.company_id),'') AS currency_code
    FROM accounts a WHERE a.company_id=$1 AND a.id=$2 AND a.active AND a.kind='posting' FOR SHARE OF a`,[companyId,input.accountId])).rows[0];
  if (!account) invalid("اختر حسابًا حركيًا فعالًا من دليل حسابات الشركة");
  if(input.cashAccountId!==null && !(await client.query(`SELECT id FROM accounts
    WHERE company_id=$1 AND id=$2 AND active AND kind='posting' AND category='asset' AND cash_or_bank
    FOR SHARE`,[companyId,input.cashAccountId])).rows.length)
    invalid("اختر صندوقًا أو بنكًا حركيًا فعالًا من الشركة");
  const row = (await client.query(`INSERT INTO expected_cards(company_id,account_id,section,currency_code,amount,description,recurrence,weekday,month_day,once_date,start_date,end_date,expiry_mode,created_by,idempotency_key,creation_payload,created_by_name,cash_account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [companyId,input.accountId,input.section,account.currency_code,input.amount,input.description,input.recurrence,input.weekday??null,input.monthDay??null,input.onceDate??null,startDate,input.endDate,input.expiryMode,user.id,input.idempotencyKey,payload,user.displayName,input.cashAccountId])).rows[0];
  await client.query(`INSERT INTO expected_movements(company_id,card_id,original_date,movement_date,amount,description,posted_by,posted_by_name)
    SELECT $1,$2,day,day,$3,$4,$6,$7 FROM unnest($5::date[]) AS day`,[companyId,row.id,input.amount,input.description,dates,user.id,user.displayName]);
  const card = await readExpectedCard(client,companyId,row.id);
  await audit(client,user,"expected.card.create","expectedCard",card.id,null,card,companyId);
  return {card,created:true};
}

const cardColumns: Record<string,string> = {id:"c.id",accountId:"c.account_id",accountName:"a.name",accountCode:"a.code",section:"c.section",currencyCode:"c.currency_code",
  cashAccountId:"c.cash_account_id",cashAccountName:"cashbox.name",cashAccountCode:"cashbox.code",
  amount:"c.amount",description:"c.description",recurrence:"c.recurrence",weekday:"c.weekday",monthDay:"c.month_day",onceDate:"c.once_date",startDate:"c.start_date",endDate:"c.end_date",
  expiryMode:"c.expiry_mode",movementCount:"stats.movement_count",pendingCount:"stats.pending_count",completedCount:"stats.completed_count",createdAt:"c.created_at",createdByName:"c.created_by_name"};
const movementColumns: Record<string,string> = {id:"m.id",cardId:"m.card_id",accountId:"c.account_id",accountName:"a.name",accountCode:"a.code",section:"c.section",currencyCode:"c.currency_code",
  date:"m.movement_date",originalDate:"m.original_date",amount:"m.amount",description:"m.description",status:"m.status",completedAmount:"m.completed_amount",completedAt:"m.completed_at",
  completionSource:"m.completion_source",revision:"m.revision",originalAmount:"c.amount",originalDescription:"c.description",expiryMode:"c.expiry_mode",updatedAt:"m.updated_at",
  postedByName:"m.posted_by_name",postedAt:"m.posted_at",completedByName:"m.completed_by_name"};
function addCommonFilters(query: Record<string,unknown>, clauses: string[], values: unknown[]) {
  if (query.accountId !== undefined) {
    if (typeof query.accountId !== "string" || !/^[1-9]\d*$/.test(query.accountId) || Number(query.accountId)>2_147_483_647) invalid("الحساب المحدد غير صالح");
    values.push(Number(query.accountId));clauses.push(`c.account_id=$${values.length}`);
  }
  if (query.section !== undefined) {
    if (typeof query.section !== "string" || query.section.length>120) invalid("القسم غير صالح");
    values.push(query.section.trim());clauses.push(`c.section=$${values.length}`);
  }
}
export async function listExpectedCards(db: Database, companyId: number, input: Record<string,unknown>) {
  const query = listQuery(input,cardColumns,"id:desc",new Set(["cashAccountId","cashAccountName","cashAccountCode"]));
  const visibility=input.visibility??"active";
  if(visibility!=="active" && visibility!=="archived") invalid("حالة الكرت غير صالحة");
  const values: unknown[]=[companyId];const clauses=["c.company_id=$1",visibility==="archived"?"c.archived_at IS NOT NULL":"c.archived_at IS NULL"];
  addCommonFilters(input,clauses,values);
  if (query.q) {values.push(searchPattern(query.q));const p=`$${values.length}`;clauses.push(`(a.name ILIKE ${p} OR a.code ILIKE ${p} OR cashbox.name ILIKE ${p} OR cashbox.code ILIKE ${p} OR c.description ILIKE ${p} OR c.section ILIKE ${p} OR c.id::text ILIKE ${p})`);}
  const where=clauses.join(" AND ");
  const count=await db.query<{total:number}>(`SELECT count(*)::integer AS total FROM expected_cards c JOIN accounts a ON (a.company_id,a.id)=(c.company_id,c.account_id)
    LEFT JOIN accounts cashbox ON (cashbox.company_id,cashbox.id)=(c.company_id,c.cash_account_id) WHERE ${where}`,values);
  const rows=await db.query(`${cardSelect} WHERE ${where} ORDER BY ${query.order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,query.pageSize,query.offset]);
  return {items:rows.rows.map(cardDTO),total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
}
export async function listExpectedMovements(db: Database, companyId: number, input: Record<string,unknown>) {
  const query=listQuery(input,movementColumns,"date:asc,id:asc",new Set(["completedAt","completedAmount","completionSource"]));
  const values:unknown[]=[companyId];const clauses=["m.company_id=$1","m.archived_at IS NULL"];
  addCommonFilters(input,clauses,values);
  if(input.cardId!==undefined) {
    if(typeof input.cardId!=="string" || !/^[1-9]\d*$/.test(input.cardId) || Number(input.cardId)>2_147_483_647) invalid("الكرت المحدد غير صالح");
    values.push(Number(input.cardId));clauses.push(`m.card_id=$${values.length}`);
  }
  if(input.cashAccountId!==undefined) {
    if(input.cashAccountId==="none") clauses.push("c.cash_account_id IS NULL");
    else {
      if(typeof input.cashAccountId!=="string" || !/^[1-9]\d*$/.test(input.cashAccountId) || Number(input.cashAccountId)>2_147_483_647) invalid("الصندوق المحدد غير صالح");
      values.push(Number(input.cashAccountId));clauses.push(`c.cash_account_id=$${values.length}`);
    }
  }
  if(input.status!==undefined) {
    if(typeof input.status!=="string" || !["pending","completed"].includes(input.status)) invalid("الحالة غير صالحة");
    values.push(input.status);clauses.push(`m.status=$${values.length}`);
  }
  for(const [key,operator] of [["dateFrom",">="],["dateTo","<="]] as const) {
    if(input[key]===undefined) continue;
    const date=expectedDateSchema.safeParse(input[key]);
    if(!date.success) invalid("التاريخ غير صالح");
    values.push(date.data);clauses.push(`m.movement_date ${operator} $${values.length}::date`);
  }
  if(input.dateFrom && input.dateTo && String(input.dateFrom)>String(input.dateTo)) invalid("بداية الفترة بعد نهايتها");
  if(query.q) {values.push(searchPattern(query.q));const p=`$${values.length}`;clauses.push(`(a.name ILIKE ${p} OR a.code ILIKE ${p} OR m.description ILIKE ${p} OR c.description ILIKE ${p} OR c.section ILIKE ${p} OR m.card_id::text ILIKE ${p})`);}
  const where=clauses.join(" AND ");
  const from=`FROM expected_movements m JOIN expected_cards c ON (c.company_id,c.id)=(m.company_id,m.card_id) JOIN accounts a ON (a.company_id,a.id)=(c.company_id,c.account_id)`;
  const count=await db.query<{total:number}>(`SELECT count(*)::integer AS total ${from} WHERE ${where}`,values);
  const rows=await db.query(`${movementSelect} WHERE ${where} ORDER BY ${query.order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,query.pageSize,query.offset]);
  return {items:rows.rows.map(movementDTO),total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
}
export async function expectedSections(db: Database, companyId:number, search:unknown) {
  if(search!==undefined && (typeof search!=="string" || search.length>120)) invalid("البحث عن قسم غير صالح");
  const rows=await db.query<{section:string}>(`SELECT DISTINCT section FROM expected_cards WHERE company_id=$1 AND section<>'' AND section ILIKE $2 ORDER BY section LIMIT 100`,[companyId,searchPattern(typeof search==="string"?search.trim():"")]);
  return {items:rows.rows.map(row=>row.section)};
}
/** Minimal account directory for this planning screen; no balances or financial detail. */
export async function expectedAccounts(db:Database,companyId:number,input:Record<string,unknown>) {
  const query=listQuery(input,{id:"a.id",name:"a.name",code:"a.code"},"name:asc");
  const values=[companyId,searchPattern(query.q)];
  const where="a.company_id=$1 AND a.active AND a.kind='posting' AND (a.name ILIKE $2 OR a.code ILIKE $2)";
  const count=await db.query<{total:number}>(`SELECT count(*)::integer AS total FROM accounts a WHERE ${where}`,values);
  const rows=await db.query<{id:number;name:string;code:string}>(`SELECT a.id,a.name,a.code FROM accounts a WHERE ${where} ORDER BY ${query.order} LIMIT $3 OFFSET $4`,[...values,query.pageSize,query.offset]);
  return {items:rows.rows,total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
}
/** Same technical cash/bank eligibility as vouchers, with only identity fields exposed. */
export async function expectedCashboxes(db:Database,companyId:number,input:Record<string,unknown>,linkedOnly=false) {
  const query=listQuery(input,{id:"a.id",name:"a.name",code:"a.code"},"name:asc");
  const values=[companyId,searchPattern(query.q)];
  const eligible="a.active AND a.kind='posting' AND a.category='asset' AND a.cash_or_bank";
  const linked="EXISTS (SELECT 1 FROM expected_cards c WHERE c.company_id=a.company_id AND c.cash_account_id=a.id)";
  const where=`a.company_id=$1 AND (${linkedOnly ? linked : eligible}) AND (a.name ILIKE $2 OR a.code ILIKE $2)`;
  const count=await db.query<{total:number}>(`SELECT count(*)::integer AS total FROM accounts a WHERE ${where}`,values);
  const rows=await db.query<{id:number;name:string;code:string}>(`SELECT a.id,a.name,a.code FROM accounts a WHERE ${where} ORDER BY ${query.order} LIMIT $3 OFFSET $4`,[...values,query.pageSize,query.offset]);
  return {items:rows.rows,total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
}
async function lockMovement(client:PoolClient,companyId:number,movementId:number) {
  // Match lifecycle's card-before-movement lock order, so archive cannot race an edit.
  const card=(await client.query(`SELECT c.archived_at FROM expected_movements m
    JOIN expected_cards c ON (c.company_id,c.id)=(m.company_id,m.card_id)
    WHERE m.company_id=$1 AND m.id=$2 AND m.archived_at IS NULL FOR SHARE OF c`,[companyId,movementId])).rows[0];
  if(!card) missing("حركة المتوقع غير موجودة");
  if(!(await client.query("SELECT id FROM expected_movements WHERE company_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE",[companyId,movementId])).rows.length) missing("حركة المتوقع غير موجودة");
  return readExpectedMovement(client,companyId,movementId);
}
export async function updateExpectedMovement(client:PoolClient,user:User,companyId:number,movementId:number,input:ExpectedMovementPatch) {
  const before=await lockMovement(client,companyId,movementId);
  if(before.revision!==input.revision) conflict("تغيرت الحركة منذ فتحها؛ حدّثها وراجع القيم قبل الحفظ");
  if(before.status!=="pending") conflict("الحركة منجزة ولا تقبل التعديل");
  if(before.cardArchived) {
    if(input.description!==before.description)
      conflict("الكرت مؤرشف؛ يمكن تعديل تاريخ الحركة ومبلغها فقط");
    await client.query(`UPDATE expected_movements SET movement_date=$3,amount=$4,revision=revision+1,updated_at=clock_timestamp()
      WHERE company_id=$1 AND id=$2`,[companyId,movementId,input.date,input.amount]);
  } else {
    await client.query(`UPDATE expected_movements SET movement_date=$3,amount=$4,description=$5,revision=revision+1,updated_at=clock_timestamp()
      WHERE company_id=$1 AND id=$2`,[companyId,movementId,input.date,input.amount,input.description]);
  }
  const movement=await readExpectedMovement(client,companyId,movementId);
  await audit(client,user,"expected.movement.update","expectedMovement",movementId,before,movement,companyId);
  return movement;
}
export async function completeExpectedMovement(client:PoolClient,user:User,companyId:number,movementId:number,revision:number) {
  const before=await lockMovement(client,companyId,movementId);
  // Preserved movements can be completed despite their parent card being archived.
  // A repeated completion is observational: no second change or audit event.
  if(before.status==="completed") return before;
  if(before.revision!==revision) conflict("تغيرت الحركة منذ فتحها؛ راجع مبلغها وتاريخها قبل الإنجاز");
  await client.query(`UPDATE expected_movements SET status='completed',completed_amount=amount,completed_at=clock_timestamp(),completed_by=$3,completed_by_name=$4,completion_source='manual',revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2`,[companyId,movementId,user.id,user.displayName]);
  const movement=await readExpectedMovement(client,companyId,movementId);
  await audit(client,user,"expected.movement.complete","expectedMovement",movementId,before,movement,companyId);
  return movement;
}

async function lockExpectedWorker(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('expected-midnight'))");
}

export async function changeExpectedCardLifecycle(client: PoolClient,user: User,companyId: number,cardId: number,input: ExpectedCardLifecycle, now?: Date) {
  await lockExpectedWorker(client);
  if(!(await client.query("SELECT id FROM expected_cards WHERE company_id=$1 AND id=$2 FOR UPDATE",[companyId,cardId])).rows.length) missing("كرت المتوقع غير موجود");
  const before=await readExpectedCard(client,companyId,cardId);
  if(before.lifecycleRevision!==input.revision) conflict("تغيرت حالة الكرت؛ حدّث الصفحة أولًا");
  if(input.action==="archive") {
    if(before.archivedAt) conflict("الكرت مؤرشف بالفعل");
    const clock=now??new Date();
    const day=expectedAdenDate(clock);
    await client.query(`UPDATE expected_cards SET archived_at=$3,archive_day=$4,lifecycle_revision=lifecycle_revision+1
      WHERE company_id=$1 AND id=$2`,[companyId,cardId,clock,day]);
    // Both dates must be eligible: a historical row carried forward is still protected.
    await client.query(`UPDATE expected_movements SET archived_at=$3,revision=revision+1,updated_at=$3
      WHERE company_id=$1 AND card_id=$2 AND archived_at IS NULL AND status='pending'
        AND original_date > $4::date AND movement_date > $4::date`,[companyId,cardId,clock,day]);
  } else {
    if(!before.archivedAt) conflict("الكرت غير مؤرشف");
    if(before.purgedMovementCount) conflict("لا يمكن استعادة الكرت بعد حذف توقعاته");
    await client.query(`UPDATE expected_movements SET archived_at=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE company_id=$1 AND card_id=$2 AND archived_at IS NOT NULL`,[companyId,cardId]);
    await client.query(`UPDATE expected_cards SET archived_at=NULL,archive_day=NULL,lifecycle_revision=lifecycle_revision+1
      WHERE company_id=$1 AND id=$2`,[companyId,cardId]);
  }
  const card=await readExpectedCard(client,companyId,cardId);
  await audit(client,user,`expected.card.${input.action}`,"expectedCard",cardId,
    {archivedAt:before.archivedAt,archivedMovementCount:before.archivedMovementCount},
    {archivedAt:card.archivedAt,archivedMovementCount:card.archivedMovementCount},companyId);
  return card;
}

async function purgeCancelledExpectedMovements(client: PoolClient, now?: Date) {
  // Forecast rows are independent of ledger records. Only rows explicitly marked by archive
  // are eligible, and completion metadata and both historical dates are checked again.
  return (await client.query<{purged:number}>(`WITH deleted AS (
    DELETE FROM expected_movements m USING expected_cards c
    WHERE (m.company_id,m.card_id)=(c.company_id,c.id)
      AND m.archived_at=c.archived_at
      AND m.archived_at<=COALESCE($1::timestamptz,clock_timestamp())-interval '720 hours'
      AND m.original_date>c.archive_day AND m.movement_date>c.archive_day
      AND m.status='pending' AND m.completed_at IS NULL AND m.completed_amount IS NULL
      AND m.completed_by IS NULL AND m.completion_source IS NULL
    RETURNING m.company_id,m.card_id
  ), counts AS (
    SELECT company_id,card_id,count(*)::integer AS n FROM deleted GROUP BY company_id,card_id
  ), updated AS (
    UPDATE expected_cards c SET purged_movement_count=c.purged_movement_count+counts.n,lifecycle_revision=c.lifecycle_revision+1
    FROM counts WHERE (c.company_id,c.id)=(counts.company_id,counts.card_id)
    RETURNING c.company_id,c.id,counts.n,c.archive_day,c.purged_movement_count
  ), logged AS (
    INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
    SELECT NULL,'النظام','company',company_id,'expected.card.purge','expectedCard',id,NULL,
      jsonb_build_object('deleted',n,'archiveDay',archive_day,'totalDeleted',purged_movement_count) FROM updated RETURNING id
  ) SELECT count(*)::integer AS purged FROM deleted`,[now??null])).rows[0].purged;
}

/** One transaction updates existing overdue rows. No card expiry check: carry remains open after its last generated date. */
export async function processExpectedMidnight(pool:Pool, now?:Date):Promise<{carried:number;completed:number;purged:number}> {
  return transaction(pool,async client=>{
    await lockExpectedWorker(client);
    const today=now?expectedAdenDate(now):await databaseToday(client);
    const result=await client.query<{carried:number;completed:number}>(`WITH overdue AS MATERIALIZED (
      SELECT m.id,m.company_id,m.movement_date,m.amount,m.description,m.status,m.revision,m.posted_by,m.posted_by_name,m.posted_at,c.expiry_mode
      FROM expected_movements m JOIN expected_cards c ON (c.company_id,c.id)=(m.company_id,m.card_id)
      WHERE m.status='pending' AND m.archived_at IS NULL AND c.archived_at IS NULL AND m.movement_date<$1::date FOR UPDATE OF m
    ), changed AS (
      UPDATE expected_movements m SET
        movement_date=CASE WHEN o.expiry_mode='carry' THEN $1::date ELSE m.movement_date END,
        status=CASE WHEN o.expiry_mode='complete' THEN 'completed' ELSE 'pending' END,
        completed_amount=CASE WHEN o.expiry_mode='complete' THEN m.amount ELSE NULL END,
        completed_at=CASE WHEN o.expiry_mode='complete' THEN clock_timestamp() ELSE NULL END,
        posted_by=CASE WHEN o.expiry_mode='carry' THEN NULL ELSE m.posted_by END,
        posted_by_name=CASE WHEN o.expiry_mode='carry' THEN 'النظام' ELSE m.posted_by_name END,
        posted_at=CASE WHEN o.expiry_mode='carry' THEN clock_timestamp() ELSE m.posted_at END,
        completed_by_name=CASE WHEN o.expiry_mode='complete' THEN 'النظام' ELSE '' END,
        completed_by=NULL,completion_source=CASE WHEN o.expiry_mode='complete' THEN 'automatic' ELSE NULL END,
        revision=m.revision+1,updated_at=clock_timestamp()
      FROM overdue o WHERE m.company_id=o.company_id AND m.id=o.id
      RETURNING m.*,o.expiry_mode,o.movement_date AS prior_date,o.status AS prior_status,o.revision AS prior_revision,
        o.posted_by AS prior_posted_by,o.posted_by_name AS prior_posted_by_name,o.posted_at AS prior_posted_at
    ), logged AS (
      INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
      SELECT NULL,'النظام','company',company_id,'expected.midnight','expectedMovement',id,
        jsonb_build_object('date',prior_date,'amount',amount::text,'description',description,'status',prior_status,'revision',prior_revision,'postedById',prior_posted_by,'postedByName',prior_posted_by_name,'postedAt',prior_posted_at),
        jsonb_build_object('date',movement_date,'amount',amount::text,'description',description,'status',status,'completedAmount',completed_amount::text,'completedAt',completed_at,'completedByName',completed_by_name,
          'revision',revision,'processingDate',$1::text,'postedById',posted_by,'postedByName',posted_by_name,'postedAt',posted_at)
      FROM changed RETURNING id
    ) SELECT count(*) FILTER (WHERE expiry_mode='carry')::integer AS carried,
      count(*) FILTER (WHERE expiry_mode='complete')::integer AS completed FROM changed`,[today]);
    return {...result.rows[0],purged:await purgeCancelledExpectedMovements(client,now)};
  });
}

/** Exact Aden midnight, startup catch-up, and bounded retries after errors. */
export function startExpectedMidnightWorker(pool:Pool):()=>Promise<void> {
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let running:Promise<void>|null=null;
  const schedule=(delay:number)=>{if(stopped)return;timer=setTimeout(tick,delay);timer.unref();};
  const tick=()=>{
    if(stopped||running)return;
    let succeeded=false;
    running=processExpectedMidnight(pool).then(result=>{
      succeeded=true;
      if(result.carried||result.completed||result.purged) console.info("EXPECTED_MIDNIGHT_PROCESSED",result);
    }).catch((error:unknown)=>{
      const code=error&&typeof error==="object"&&"code" in error?String(error.code):"worker_error";
      console.error("EXPECTED_MIDNIGHT_FAILED",/^[a-zA-Z0-9_]{1,32}$/.test(code)?code:"worker_error");
    }).finally(()=>{
      running=null;
      schedule(succeeded?Math.max(1,expectedNextMidnight()-Date.now()):30_000);
    });
  };
  tick();
  return async()=>{stopped=true;if(timer)clearTimeout(timer);await running;};
}

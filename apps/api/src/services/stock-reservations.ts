import type { PoolClient, QueryResultRow } from "pg";
import type {
 StockReservation, StockReservationAvailability, StockReservationInput,
 StockReservationReleaseInput, User,
} from "../../../../packages/contracts/src/index.ts";
import { missing, HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { conflict } from "./masters.ts";
import { directoryEntries } from "./pages.ts";
import { checkStockLocation, itemStockSnapshot, stockUnitMultiplier } from "./inventory.ts";

const toDate=(v:string|null):string|null=>v===null||v===""?null:v;
function dto(r:QueryResultRow):StockReservation {
 return {
  id:r.id,companyId:r.company_id,itemId:r.item_id,locationId:r.location_id,
  expiryDate:toDate(r.batch_key),
  unit:r.unit,quantity:String(r.quantity_entered),quantitySmallest:String(r.quantity_smallest),
  sourceType:"manual",sourceReference:r.source_reference,description:r.description,
  status:r.status,reservedBy:r.reserved_by,reservedAt:new Date(r.reserved_at).toISOString(),
  releasedBy:r.released_by,releasedAt:r.released_at?new Date(r.released_at).toISOString():null,
  releaseReason:r.release_reason,
 };
}
export async function requireReservationView(client:PoolClient,user:User,companyId:number):Promise<void> {
 const pages=await directoryEntries(client,user,companyId);
 for(const key of ["company.stock-balances","company.stock-movements"]) {
  if(!pages.find(p=>p.key===key)?.actionAccess.view)
   throw new HttpError(403,"inventory_view_denied","تتطلب الحجوزات صلاحيات عرض الأرصدة وحركات المخزون");
 }
}
export async function getReservation(client:PoolClient,companyId:number,id:number):Promise<StockReservation> {
 const row=(await client.query("SELECT * FROM stock_reservations WHERE company_id=$1 AND id=$2",
   [companyId,id])).rows[0];
 if(!row)missing();
 return dto(row);
}
export async function createReservation(
 client:PoolClient,user:User,companyId:number,input:StockReservationInput,
):Promise<{created:boolean;reservation:StockReservation}> {
 const payload=JSON.stringify(input);
 const replay=(await client.query(
   "SELECT id,creation_payload=$3::jsonb AS identical FROM stock_reservations WHERE company_id=$1 AND idempotency_key=$2",
   [companyId,input.idempotencyKey,payload],
 )).rows[0];
 if(replay){
  if(!replay.identical)conflict("مفتاح الحجز مستخدم لبيانات مختلفة");
  return {created:false,reservation:await getReservation(client,companyId,replay.id)};
 }
 const item=await itemStockSnapshot(client,companyId,input.itemId);
 await checkStockLocation(client,companyId,input.locationId);
 const loc=(await client.query(
   "SELECT kind FROM locations WHERE company_id=$1 AND id=$2",
   [companyId,input.locationId],
 )).rows[0];
 if(loc?.kind!=="showroom")conflict("حجز الكميات المتاحة للبيع مسموح من المعرض فقط");
 if(item.hasExpiry!==!!input.expiryDate)
  conflict(item.hasExpiry?"يجب اختيار تاريخ انتهاء الدفعة المراد حجزها":"الصنف لا يحتاج تاريخ انتهاء");
 const day=(await client.query(
   "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
 )).rows[0].today as string;
 if(input.expiryDate&&input.expiryDate<day)
  conflict("لا يمكن حجز دفعة منتهية الصلاحية");
 const smallest=BigInt(input.quantity)*stockUnitMultiplier(item,input.unit);
 if(smallest<=0n||smallest>=10n**40n)
  throw new HttpError(400,"quantity_overflow","الكمية تتجاوز الحد المدعوم");
 const batch=input.expiryDate??"";
 // The company row is locked by mutateMaster; row lock additionally coordinates with stock postings.
 const balance=(await client.query(
   "SELECT quantity_smallest FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND location_id=$3 AND batch_key=$4 FOR UPDATE",
   [companyId,item.id,input.locationId,batch],
 )).rows[0];
 const physical=balance?BigInt(balance.quantity_smallest):0n;
 const held=(await client.query(
   `SELECT COALESCE(sum(quantity_smallest),0)::text AS held FROM stock_reservations
     WHERE company_id=$1 AND item_id=$2 AND location_id=$3 AND batch_key=$4 AND status='active'`,
   [companyId,item.id,input.locationId,batch],
 )).rows[0].held as string;
 if(smallest>physical-BigInt(held))
  conflict("الكمية المتاحة للبيع في الدفعة لا تكفي لإتمام الحجز");
 const inserted=(await client.query(
   `INSERT INTO stock_reservations(
     company_id,item_id,location_id,batch_key,unit,quantity_entered,quantity_smallest,
     source_type,source_reference,description,reserved_by,idempotency_key,creation_payload
   ) VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,$12::jsonb) RETURNING id`,
   [companyId,item.id,input.locationId,batch,input.unit,input.quantity,smallest.toString(),
    input.sourceReference,input.description,user.id,input.idempotencyKey,payload],
 )).rows[0];
 const reservation=await getReservation(client,companyId,inserted.id);
 await audit(client,user,"stockReservation.create","stockReservation",
   reservation.id,null,reservation,companyId);
 return {created:true,reservation};
}
export async function releaseReservation(
 client:PoolClient,user:User,companyId:number,id:number,input:StockReservationReleaseInput,
):Promise<{created:boolean;reservation:StockReservation}> {
 const before=await getReservation(client,companyId,id);
 const raw=(await client.query(
   "SELECT status,release_key,release_reason FROM stock_reservations WHERE company_id=$1 AND id=$2 FOR UPDATE",
   [companyId,id],
 )).rows[0];
 if(raw.status==="released"){
  if(raw.release_key===input.idempotencyKey&&raw.release_reason===input.reason)
   return {created:false,reservation:before};
  conflict("تم تحرير الحجز سابقًا؛ لا يمكن تحريره مجددًا");
 }
 await client.query(
  `UPDATE stock_reservations SET status='released',released_by=$1,
    released_at=clock_timestamp(),release_reason=$2,release_key=$3
   WHERE company_id=$4 AND id=$5 AND status='active'`,
  [user.id,input.reason,input.idempotencyKey,companyId,id],
 );
 const reservation=await getReservation(client,companyId,id);
 await audit(client,user,"stockReservation.release","stockReservation",
   id,before,reservation,companyId);
 return {created:true,reservation};
}
export async function readItemReservationAvailability(
 client:PoolClient,companyId:number,itemId:number,
):Promise<StockReservationAvailability> {
 const item=(await client.query(
   "SELECT id,unit1_name,unit2_name,unit3_name,factor2,factor3 FROM items WHERE company_id=$1 AND id=$2",
   [companyId,itemId],
 )).rows[0];
 if(!item)missing();
 const rows=await client.query(
   `SELECT s.location_id,l.name AS location_name,s.batch_key,
      s.quantity_smallest::text AS physical,
      COALESCE(r.reserved,0)::text AS reserved,
      GREATEST(s.quantity_smallest-COALESCE(r.reserved,0),0)::text AS available
    FROM stock_balances s
    JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id
    JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id
    LEFT JOIN LATERAL (
      SELECT sum(quantity_smallest) AS reserved FROM stock_reservations r
      WHERE r.company_id=s.company_id AND r.item_id=s.item_id
        AND r.location_id=s.location_id AND r.batch_key=s.batch_key
        AND r.status='active'
    ) r ON TRUE
    WHERE s.company_id=$1 AND s.item_id=$2
      AND l.kind='showroom' AND l.active AND b.active
      AND (s.batch_key='' OR s.batch_key >=
        (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text)
    ORDER BY l.name,s.batch_key,s.id LIMIT 51`,
   [companyId,itemId],
 );
 const active=await client.query(
   `SELECT * FROM stock_reservations
      WHERE company_id=$1 AND item_id=$2 AND status='active'
      ORDER BY id DESC LIMIT 51`,[companyId,itemId],
 );
 return {
  companyId,itemId,unit1Name:item.unit1_name,unit2Name:item.unit2_name,
  unit3Name:item.unit3_name,factor2:item.factor2,factor3:item.factor3,
  lots:rows.rows.slice(0,50).map(r=>({
    locationId:r.location_id,locationName:r.location_name,expiryDate:toDate(r.batch_key),
    physicalSmallest:r.physical,reservedSmallest:r.reserved,availableSmallest:r.available,
  })),
  truncated:rows.rows.length>50,
  reservations:active.rows.slice(0,50).map(dto),
  reservationsTruncated:active.rows.length>50,
 };
}

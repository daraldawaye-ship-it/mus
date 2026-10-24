import type { PoolClient } from "pg";
import type { ItemCompositionPeers, User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";

/** Existing composition relationship only: no reservation or implied interchangeable stock. */
export async function readItemCompositionPeers(
 client: PoolClient,user: User,companyId: number,itemId: number,page: number,pageSize: 10 | 20 = 20,
): Promise<ItemCompositionPeers> {
 const primary=(await client.query(
   `SELECT i.composition_id,c.arabic_name,c.english_name,c.active,
     c.identical_alternative,c.non_interchangeable
    FROM items i LEFT JOIN item_compositions c
      ON c.company_id=i.company_id AND c.id=i.composition_id
    WHERE i.company_id=$1 AND i.id=$2`,[companyId,itemId],
 )).rows[0];
 if(!primary) missing();
 const permissions=await directoryEntries(client,user,companyId);
 const allowed=(key:string)=>!!permissions.find(p=>p.key===key)?.actionAccess.view;
 const canViewStock=allowed("company.stock-balances")&&allowed("company.stock-movements");
 const composition=primary.composition_id===null?null:{
   id:primary.composition_id as number,arabicName:primary.arabic_name as string,
   englishName:primary.english_name as string,active:primary.active as boolean,
   identicalAlternative:primary.identical_alternative as boolean,
   nonInterchangeable:primary.non_interchangeable as boolean,
 };
 const relation:ItemCompositionPeers["relation"]=!composition?"none":
   composition.nonInterchangeable?"nonInterchangeable":
   composition.active&&composition.identicalAlternative?"identicalAlternative":"sameComposition";
 const result:ItemCompositionPeers={
   companyId,itemId,canViewStock,composition,relation,
   total:0,page,pageSize,peers:[],
 };
 if(!composition)return result;
 const count=await client.query(
   "SELECT count(*)::int AS total FROM items WHERE company_id=$1 AND composition_id=$2 AND id<>$3 AND active=true",
   [companyId,composition.id,itemId],
 );
 result.total=count.rows[0]?.total??0;
 const stockCol=canViewStock?"s.stock_total::text AS stock_smallest":"NULL::text AS stock_smallest";
 const stockJoin=canViewStock
   ?"LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id":"";
 // Sort across the entire set before paging, comparing real unit-1 quantities,
 // not raw smallest-unit stock from items with different conversion factors.
 const stockOrder=canViewStock
   ? "COALESCE(s.stock_total,0)::numeric / (i.factor2::numeric * i.factor3::numeric) DESC,i.code,i.id"
   : "i.code,i.id";
 const rows=await client.query(
   `SELECT i.id,i.code,i.name,i.active,i.unit1_name,i.unit2_name,i.unit3_name,
     i.factor2,i.factor3,${stockCol}
    FROM items i ${stockJoin}
    WHERE i.company_id=$1 AND i.composition_id=$2 AND i.id<>$3 AND i.active=true
    ORDER BY ${stockOrder} LIMIT $5 OFFSET $4`,
   [companyId,composition.id,itemId,(page-1)*pageSize,pageSize],
 );
 result.peers=rows.rows.map(r=>({
   id:r.id,code:r.code,name:r.name,active:r.active,
   smallestUnitName:r.factor3>1?r.unit3_name:r.factor2>1?r.unit2_name:r.unit1_name,
   unit1Name:r.unit1_name,factor2:r.factor2,factor3:r.factor3,
   stockSmallest:r.stock_smallest??(canViewStock?"0":null),
 }));
 return result;
}

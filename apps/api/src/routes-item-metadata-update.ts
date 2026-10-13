import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { handler, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { mutateMaster } from "./services/masters.ts";

// Updates existing records only. Never inserts, deletes, changes stock,
// monetary fields, item code or cost. Uses each existing legacy ID as key.
const metadataRow=z.object({
  legacyId:z.string().regex(/^[0-9]{1,100}$/),
  compositionName:z.string().trim().min(1).max(240).nullable(),
  shelf:z.string().trim().max(100).nullable(),
  defaultSaleUnit:z.union([z.literal(1),z.literal(2),z.literal(3)]).nullable(),
}).strict();
const batchSchema=z.object({
  format:z.literal("tijara-item-metadata-v1"),
  companyHint:z.string().min(3).max(200),
  items:z.array(metadataRow).min(1).max(80),
}).strict();
const simplified=(text:string)=>text.normalize("NFKC")
  .replace(/[\s\u0640]/g,"").replace(/[أإآ]/g,"ا").toLocaleLowerCase();
const normalizedComposition=(text:string)=>text.trim().toLocaleLowerCase();

export function itemMetadataUpdateRoutes(pool:Pool):Router {
  const router=Router();
  router.post("/companies/:companyId/items/metadata-update-batch",
    handler(async(req,res)=>{
      const body=parse(batchSchema,req.body);
      const result=await mutateMaster(pool,req,"items.manage",async(db,user,companyId)=>{
        const company=await db.query("SELECT name FROM companies WHERE id=$1",[companyId]);
        const name=String(company.rows[0]?.name??"");
        const expected=simplified(body.companyHint), actual=simplified(name);
        if(expected!==actual || !expected.includes("دارالدواء"))
          throw new HttpError(409,"wrong_company",
            "ملف تحديث الأصناف مخصص لصيدلية دار الدواء؛ اختر الشركة الصحيحة.");
        const ids=body.items.map(x=>x.legacyId);
        if(new Set(ids).size!==ids.length)
          throw new HttpError(400,"duplicate_legacy_id","المعرف القديم مكرر في الدفعة.");
        const existing=await db.query(
          `SELECT id,legacy_id,composition_id,shelf_id,shelf,default_sale_unit,
            factor2,factor3,unit2_name,unit3_name,revision
           FROM items WHERE company_id=$1 AND legacy_id=ANY($2::text[]) FOR UPDATE`,
          [companyId,ids],
        );
        const itemMap=new Map<string,typeof existing.rows[number]>(
          existing.rows.map(row=>[String(row.legacy_id),row]),
        );
        if(itemMap.size!==ids.length){
          const missing=ids.find(k=>!itemMap.has(k));
          throw new HttpError(409,"item_missing",
            `لم يُعثر على الصنف بمعرفه القديم ${missing}؛ أُوقفت الدفعة دون تعديل.`);
        }
        const [compositions,shelves]=await Promise.all([
          db.query("SELECT id,arabic_name,active FROM item_compositions WHERE company_id=$1",[companyId]),
          db.query("SELECT id,name,archived FROM item_shelves WHERE company_id=$1",[companyId]),
        ]);
        const compMap=new Map<string,{id:number;active:boolean}>();
        for(const c of compositions.rows){
          const key=normalizedComposition(c.arabic_name as string);
          if(compMap.has(key))
            throw new HttpError(409,"ambiguous_composition",
              "يوجد أكثر من تركيب يحمل الاسم نفسه في الشركة؛ أوقف التحديث للمراجعة.");
          compMap.set(key,{id:c.id as number,active:c.active as boolean});
        }
        const shelfMap=new Map<string,{id:number;archived:boolean}>(
          shelves.rows.map(r=>[r.name as string,{
            id:r.id as number,archived:r.archived as boolean,
          }]),
        );
        const staged:Array<{
          id:number;composition_id:number|null;
          shelf_id:number|null;shelf:string;default_sale_unit:number;
          before:Record<string,unknown>;
        }>=[];
        let linkedComposition=0,linkedShelf=0,legacyShelf=0,unitChanged=0;
        for(const row of body.items){
          const current=itemMap.get(row.legacyId)!;
          let compositionId=current.composition_id as number|null;
          let shelfId=current.shelf_id as number|null;
          let shelfText=String(current.shelf);
          let saleUnit=current.default_sale_unit as number;
          if(row.compositionName!==null){
            const comp=compMap.get(normalizedComposition(row.compositionName));
            if(!comp)throw new HttpError(409,"composition_missing",
              `لا يوجد كرت تركيب مطابق للصنف ${row.legacyId}؛ أُوقفت الدفعة.`);
            if(!comp.active && comp.id!==current.composition_id)
              throw new HttpError(409,"composition_archived",
                `التركيب مؤرشف للصنف ${row.legacyId}؛ أُوقفت الدفعة.`);
            compositionId=comp.id;
          }
          if(row.shelf!==null){
            shelfText=row.shelf;
            const shelf=shelfMap.get(row.shelf);
            if(shelf&&!shelf.archived)shelfId=shelf.id;
            else shelfId=null; // Unrecognized legacy labels stay as text.
          }
          if(row.defaultSaleUnit!==null){
            const requested=row.defaultSaleUnit;
            if((requested===2&&(Number(current.factor2)<=1||!current.unit2_name))||
              (requested===3&&(Number(current.factor3)<=1||!current.unit3_name)))
              throw new HttpError(409,"unit_inactive",
                `وحدة البيع ${requested} غير مفعلة في الصنف ${row.legacyId}.`);
            saleUnit=requested;
          }
          const changed=compositionId!==current.composition_id||
            shelfId!==current.shelf_id||shelfText!==current.shelf||
            saleUnit!==current.default_sale_unit;
          if(!changed)continue;
          if(compositionId!==null&&compositionId!==current.composition_id)linkedComposition++;
          if(shelfId!==null&&shelfId!==current.shelf_id)linkedShelf++;
          if(row.shelf!==null&&row.shelf!==""&&shelfId===null)legacyShelf++;
          if(saleUnit!==current.default_sale_unit)unitChanged++;
          staged.push({
            id:current.id as number,composition_id:compositionId,
            shelf_id:shelfId,shelf:shelfText,default_sale_unit:saleUnit,
            before:{
              revision:current.revision,
              compositionId:current.composition_id,shelfId:current.shelf_id,
              shelf:current.shelf,defaultSaleUnit:current.default_sale_unit,
            },
          });
        }
        if(staged.length){
          await db.query(`
            WITH patch AS (
              SELECT * FROM jsonb_to_recordset($2::jsonb)
              AS x(id integer,composition_id integer,shelf_id integer,
                   shelf text,default_sale_unit smallint,before jsonb)
            ), updated AS (
              UPDATE items i SET
                composition_id=p.composition_id,shelf_id=p.shelf_id,
                shelf=p.shelf,default_sale_unit=p.default_sale_unit,
                revision=i.revision+1,updated_at=clock_timestamp()
              FROM patch p WHERE i.company_id=$1 AND i.id=p.id
              RETURNING i.id,i.revision,i.composition_id,i.shelf_id,i.shelf,i.default_sale_unit
            )
            INSERT INTO audit_events
              (actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
            SELECT $3,$4,'company',$1,'item.update','item',u.id,p.before,
              jsonb_build_object('revision',u.revision,
                'compositionId',u.composition_id,'shelfId',u.shelf_id,
                'shelf',u.shelf,'defaultSaleUnit',u.default_sale_unit)
            FROM updated u JOIN patch p ON p.id=u.id
          `,[companyId,JSON.stringify(staged),user.id,user.displayName]);
        }
        return {
          processed:body.items.length,updated:staged.length,
          unchanged:body.items.length-staged.length,
          linkedComposition,linkedShelf,legacyShelf,unitChanged,
        };
      });
      res.json(result);
    }),
  );
  return router;
}

import { Router } from "express";
import type { Pool } from "pg";
import { doctorInputSchema, doctorPatchSchema, doctorInlinePatchSchema, doctorBulkSharedNameSchema, effectiveDoctorSharedName, type Doctor } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { readMaster, mutateMaster, conflict } from "./services/masters.ts";
import { audit } from "./services/audit.ts";
import { HttpError, missing } from "./errors.ts";

function dto(row: any): Doctor {
  return {
    id: row.id, companyId: row.company_id, name: row.name,
    sharedName: effectiveDoctorSharedName(row.name, row.shared_name), kind: row.kind,
    department: row.department, phone: row.phone, searchKeys: row.search_keys,
    notes: row.notes, active: row.active, revision: row.revision,
  };
}
export function doctorRoutes(pool: Pool): Router {
  const router = Router(), base = "/companies/:companyId/doctors";
  router.get(base, handler(async (req,res) => {
    const companyId = await readMaster(pool,req,"commerce.view");
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0,240) : "";
    const active = req.query.active;
    if (active !== undefined && active !== "true" && active !== "false")
      throw new HttpError(400,"invalid_filter","حالة الطبيب غير صالحة");
    const page = Number(req.query.page ?? 1), pageSize = Number(req.query.pageSize ?? 20);
    if (!Number.isInteger(page) || page < 1 || ![10,20,50,100].includes(pageSize))
      throw new HttpError(400,"invalid_page","صفحة البحث غير صالحة");
    const sort = String(req.query.sort ?? "name:asc");
    const sorts: Record<string,string> = {
      "name:asc":"name ASC,id ASC","name:desc":"name DESC,id DESC",
      "sharedName:asc":"shared_name ASC,name ASC,id ASC",
      "sharedName:desc":"shared_name DESC,name ASC,id ASC",
      "kind:asc":"kind ASC,name ASC,id ASC","kind:desc":"kind DESC,name ASC,id ASC",
      "department:asc":"department ASC,name ASC,id ASC","department:desc":"department DESC,name ASC,id ASC",
      "active:asc":"active ASC,name ASC,id ASC","active:desc":"active DESC,name ASC,id ASC",
      "id:asc":"id ASC","id:desc":"id DESC",
    };
    if (!sorts[sort]) throw new HttpError(400,"invalid_sort","الترتيب غير صالح");
    const rows = await pool.query(
      `SELECT *,count(*) OVER()::int AS total FROM doctors
        WHERE company_id=$1 AND ($2::boolean IS NULL OR active=$2)
        AND ($3::text='' OR name ILIKE $4 OR shared_name ILIKE $4 OR department ILIKE $4 OR phone ILIKE $4 OR search_keys ILIKE $4 OR notes ILIKE $4)
        ORDER BY ${sorts[sort]} LIMIT $5 OFFSET $6`,
      [companyId, active===undefined?null:active==="true", query, "%" + query.replace(/[\\%_]/g,"\\$&") + "%",
       pageSize, (page-1)*pageSize],
    );
    res.json({items:rows.rows.map(dto),total:rows.rows[0]?.total??0,page,pageSize});
  }));
  router.get(`${base}/departments`,handler(async(req,res)=>{
    const companyId=await readMaster(pool,req,"commerce.view");
    const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,240):"";
    const rows=await pool.query(
      "SELECT DISTINCT department FROM doctors WHERE company_id=$1 AND department<>'' AND ($2::text='' OR department ILIKE $3) ORDER BY department LIMIT 100",
      [companyId,q,"%"+q+"%"],
    );
    res.json({items:rows.rows.map(row=>row.department as string)});
  }));
  router.get(`${base}/:id`,handler(async(req,res)=>{
    const companyId=await readMaster(pool,req,"commerce.view");
    const result=await pool.query("SELECT * FROM doctors WHERE company_id=$1 AND id=$2",
      [companyId,id(req.params.id)]);
    if(!result.rows[0])missing();
    res.json({doctor:dto(result.rows[0])});
  }));
  router.post(base,handler(async(req,res)=>{
    const input=parse(doctorInputSchema,req.body);
    const doctor=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const result=await client.query(
        `INSERT INTO doctors(company_id,name,shared_name,kind,department,phone,search_keys,notes,active,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [companyId,input.name,effectiveDoctorSharedName(input.name,input.sharedName),input.kind,input.department,input.phone,input.searchKeys,input.notes,input.active,user.id]);
      const record=dto(result.rows[0]);
      await audit(client,user,"doctor.create","doctor",record.id,null,record,companyId);
      return record;
    });
    res.status(201).json({doctor});
  }));

  // Inline changes update exactly ONE field so an older table snapshot cannot
  // replace another employee's more recent changes to unrelated card details.
  router.patch(`${base}/:id/field`,handler(async(req,res)=>{
    const input=parse(doctorInlinePatchSchema,req.body),doctorId=id(req.params.id);
    const doctor=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const old=await client.query(
        "SELECT * FROM doctors WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [companyId,doctorId],
      );
      if(!old.rows[0])missing();
      if(old.rows[0].revision!==input.revision)
        conflict("تم تحديث هذا الكرت من مكان آخر؛ أعد تحديث القائمة ثم حاول مجددًا");
      const columns={
        sharedName:"shared_name", kind:"kind", department:"department",
        phone:"phone", searchKeys:"search_keys", notes:"notes", active:"active",
      } as const;
      const column=columns[input.field]; // Static allow-list; never accept SQL names from the request.
      const value=input.field==="sharedName"
        ? effectiveDoctorSharedName(old.rows[0].name,input.value)
        : input.value;
      const original=dto(old.rows[0]);
      if(original[input.field]===value)return original;
      const result=await client.query(
        `UPDATE doctors SET ${column}=$1,revision=revision+1,updated_at=clock_timestamp()
          WHERE company_id=$2 AND id=$3 RETURNING *`,
        [value,companyId,doctorId],
      );
      const updated=dto(result.rows[0]);
      if((input.field==="kind" && updated.kind!==null) ||
         (input.field==="active" && !updated.active)){
        await client.query(
          `UPDATE notifications
             SET completed_at=clock_timestamp(),
                 read_at=COALESCE(read_at,clock_timestamp()),
                 snoozed_until=NULL,next_reminder_at=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$1 AND code='SALES_DOCTOR_REVIEW'
             AND subject_key=$2 AND completed_at IS NULL`,
          [companyId,`doctor:${doctorId}`],
        );
      }
      await audit(client,user,"doctor.update","doctor",doctorId,original,updated,companyId);
      return updated;
    });
    res.json({doctor});
  }));

  // Assign only checked cards to the chosen main card in one audited transaction.
  // The clicked card is promoted to main even when it was not checked.
  router.patch(`${base}/bulk-shared-name`,handler(async(req,res)=>{
    const input=parse(doctorBulkSharedNameSchema,req.body);
    const result=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const ids=[...new Set([...input.doctorIds,input.mainDoctorId])].sort((a,b)=>a-b);
      const current=await client.query(
        "SELECT * FROM doctors WHERE company_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE",
        [companyId,ids],
      );
      // Never partially update when a selected record is missing or outside this company.
      if(current.rows.length!==ids.length)missing();
      const main=current.rows.find(row=>row.id===input.mainDoctorId);
      if(!main)missing();
      const sharedName=main.name.trim();
      const changed=current.rows.filter(row=>effectiveDoctorSharedName(row.name,row.shared_name)!==sharedName);
      if(changed.length){
        const updated=await client.query(
          `UPDATE doctors SET shared_name=$1,revision=revision+1,updated_at=clock_timestamp()
             WHERE company_id=$2 AND id=ANY($3::int[]) RETURNING *`,
          [sharedName,companyId,changed.map(row=>row.id)],
        );
        const after=new Map(updated.rows.map(row=>[row.id,dto(row)]));
        for(const row of changed){
          const next=after.get(row.id);
          if(!next)throw new Error("Missing updated doctor in bulk result");
          await audit(client,user,"doctor.update","doctor",row.id,dto(row),next,companyId);
        }
      }
      return {mainDoctorId:input.mainDoctorId,sharedName,selected:input.doctorIds.length,updated:changed.length};
    });
    res.json({result});
  }));
  router.patch(`${base}/:id`,handler(async(req,res)=>{
    const input=parse(doctorPatchSchema,req.body),doctorId=id(req.params.id);
    const doctor=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const old=await client.query("SELECT * FROM doctors WHERE company_id=$1 AND id=$2 FOR UPDATE",[companyId,doctorId]);
      if(!old.rows[0])missing();
      if(old.rows[0].revision!==input.revision)conflict("تم تعديل كرت الطبيب من مكان آخر؛ أعد تحميله");
      const sharedName = input.sharedName === undefined
        ? effectiveDoctorSharedName(old.rows[0].name, old.rows[0].shared_name)
        : effectiveDoctorSharedName(input.name, input.sharedName);
      const result=await client.query(
        `UPDATE doctors SET name=$1,shared_name=$2,kind=$3,department=$4,phone=$5,search_keys=$6,
           notes=$7,active=$8,revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$9 AND id=$10 RETURNING *`,
        [input.name,sharedName,input.kind,input.department,input.phone,input.searchKeys,input.notes,input.active,companyId,doctorId]);
      const updated=dto(result.rows[0]);
      // Completion is shared by all review recipients, including the owner.
      if (updated.kind !== null || !updated.active) {
        await client.query(
          `UPDATE notifications
             SET completed_at=clock_timestamp(),
                 read_at=COALESCE(read_at,clock_timestamp()),
                 snoozed_until=NULL,next_reminder_at=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$1 AND code='SALES_DOCTOR_REVIEW'
             AND subject_key=$2 AND completed_at IS NULL`,
          [companyId, `doctor:${doctorId}`],
        );
      }
      await audit(client,user,"doctor.update","doctor",doctorId,dto(old.rows[0]),updated,companyId);
      return updated;
    });
    res.json({doctor});
  }));
  return router;
}

import { Router } from "express";
import type { Pool } from "pg";
import { doctorInputSchema, doctorPatchSchema, type Doctor } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { readMaster, mutateMaster, conflict } from "./services/masters.ts";
import { audit } from "./services/audit.ts";
import { HttpError, missing } from "./errors.ts";

function dto(row: any): Doctor {
  return {
    id: row.id, companyId: row.company_id, name: row.name, kind: row.kind,
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
      "kind:asc":"kind ASC,name ASC,id ASC","kind:desc":"kind DESC,name ASC,id ASC",
      "department:asc":"department ASC,name ASC,id ASC","department:desc":"department DESC,name ASC,id ASC",
      "active:asc":"active ASC,name ASC,id ASC","active:desc":"active DESC,name ASC,id ASC",
      "id:asc":"id ASC","id:desc":"id DESC",
    };
    if (!sorts[sort]) throw new HttpError(400,"invalid_sort","الترتيب غير صالح");
    const rows = await pool.query(
      `SELECT *,count(*) OVER()::int AS total FROM doctors
        WHERE company_id=$1 AND ($2::boolean IS NULL OR active=$2)
        AND ($3::text='' OR name ILIKE $4 OR department ILIKE $4 OR phone ILIKE $4 OR search_keys ILIKE $4 OR notes ILIKE $4)
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
        `INSERT INTO doctors(company_id,name,kind,department,phone,search_keys,notes,active,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [companyId,input.name,input.kind,input.department,input.phone,input.searchKeys,input.notes,input.active,user.id]);
      const record=dto(result.rows[0]);
      await audit(client,user,"doctor.create","doctor",record.id,null,record,companyId);
      return record;
    });
    res.status(201).json({doctor});
  }));
  router.patch(`${base}/:id`,handler(async(req,res)=>{
    const input=parse(doctorPatchSchema,req.body),doctorId=id(req.params.id);
    const doctor=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const old=await client.query("SELECT * FROM doctors WHERE company_id=$1 AND id=$2 FOR UPDATE",[companyId,doctorId]);
      if(!old.rows[0])missing();
      if(old.rows[0].revision!==input.revision)conflict("تم تعديل كرت الطبيب من مكان آخر؛ أعد تحميله");
      const result=await client.query(
        `UPDATE doctors SET name=$1,kind=$2,department=$3,phone=$4,search_keys=$5,
           notes=$6,active=$7,revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$8 AND id=$9 RETURNING *`,
        [input.name,input.kind,input.department,input.phone,input.searchKeys,input.notes,input.active,companyId,doctorId]);
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

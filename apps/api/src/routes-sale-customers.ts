import { Router } from "express";
import type { Pool } from "pg";
import {
  saleCustomerInputSchema, saleCustomerPatchSchema, saleCustomerNumberSchema,
  type SaleCustomer,
} from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { readMaster, mutateMaster, conflict } from "./services/masters.ts";
import { audit } from "./services/audit.ts";
import { HttpError, missing } from "./errors.ts";

function dto(row: any): SaleCustomer {
  return { id:row.id, companyId:row.company_id,
    customerNumber:row.customer_number, name:row.name, revision:row.revision };
}
export function saleCustomerRoutes(pool:Pool):Router {
  const router=Router(), base="/companies/:companyId/sale-customers";
  router.get(`${base}/lookup`,handler(async(req,res)=>{
    const companyId=await readMaster(pool,req,"commerce.view");
    const number=parse(saleCustomerNumberSchema,req.query.number);
    const result=await pool.query(
      "SELECT * FROM sale_customers WHERE company_id=$1 AND customer_number=$2",
      [companyId,number],
    );
    res.json({customer:result.rows[0]?dto(result.rows[0]):null});
  }));
  router.get(base,handler(async(req,res)=>{
    const companyId=await readMaster(pool,req,"commerce.view");
    const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,240):"";
    const page=Number(req.query.page??1),pageSize=Number(req.query.pageSize??20);
    if(!Number.isInteger(page)||page<1||![10,20,50,100].includes(pageSize))
      throw new HttpError(400,"invalid_page","صفحة البحث غير صالحة");
    const sort=String(req.query.sort??"id:desc");
    const sorts:Record<string,string>={
      "id:asc":"id ASC","id:desc":"id DESC",
      "customerNumber:asc":"customer_number ASC,id ASC",
      "customerNumber:desc":"customer_number DESC,id DESC",
      "name:asc":"name ASC,id ASC","name:desc":"name DESC,id DESC",
    };
    if(!sorts[sort])throw new HttpError(400,"invalid_sort","الترتيب غير صالح");
    const pattern="%"+q.replace(/[\\%_]/g,"\\$&")+"%";
    const rows=await pool.query(
      `SELECT *,count(*) OVER()::int AS total FROM sale_customers
       WHERE company_id=$1 AND ($2::text='' OR customer_number ILIKE $3 OR name ILIKE $3)
       ORDER BY ${sorts[sort]} LIMIT $4 OFFSET $5`,
      [companyId,q,pattern,pageSize,(page-1)*pageSize],
    );
    res.json({items:rows.rows.map(dto),total:rows.rows[0]?.total??0,page,pageSize});
  }));
  router.get(`${base}/:id`,handler(async(req,res)=>{
    const companyId=await readMaster(pool,req,"commerce.view");
    const result=await pool.query(
      "SELECT * FROM sale_customers WHERE company_id=$1 AND id=$2",
      [companyId,id(req.params.id)],
    );
    if(!result.rows[0])missing();
    res.json({customer:dto(result.rows[0])});
  }));
  router.post(base,handler(async(req,res)=>{
    const input=parse(saleCustomerInputSchema,req.body);
    const customer=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const result=await client.query(
        "INSERT INTO sale_customers(company_id,customer_number,name,created_by) VALUES($1,$2,$3,$4) RETURNING *",
        [companyId,input.customerNumber,input.name,user.id],
      );
      const value=dto(result.rows[0]);
      await audit(client,user,"saleCustomer.create","saleCustomer",value.id,null,value,companyId);
      return value;
    });
    res.status(201).json({customer});
  }));
  router.patch(`${base}/:id`,handler(async(req,res)=>{
    const input=parse(saleCustomerPatchSchema,req.body),customerId=id(req.params.id);
    const customer=await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
      const old=await client.query(
        "SELECT * FROM sale_customers WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [companyId,customerId],
      );
      if(!old.rows[0])missing();
      if(old.rows[0].revision!==input.revision)conflict("تغيّر كرت العميل؛ أعد تحميله");
      const result=await client.query(
        `UPDATE sale_customers SET customer_number=$1,name=$2,
         revision=revision+1,updated_at=clock_timestamp()
         WHERE company_id=$3 AND id=$4 RETURNING *`,
        [input.customerNumber,input.name,companyId,customerId],
      );
      const value=dto(result.rows[0]);
      await audit(client,user,"saleCustomer.update","saleCustomer",customerId,dto(old.rows[0]),value,companyId);
      return value;
    });
    res.json({customer});
  }));
  return router;
}

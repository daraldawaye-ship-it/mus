import type {RequestHandler} from "express";
import type {Pool} from "pg";
import {userDTO} from "./repositories/models.ts";
import {HttpError} from "./errors.ts";

/**
 * The browser owner remains authenticated as themselves. Only explicitly
 * scoped company GETs are evaluated using the selected active employee.
 * No header can make an unauthenticated/non-owner session an employee.
 */
export function ownerReadOnlyPreview(pool:Pool):RequestHandler {
  return (req,_res,next)=>{
    const token=req.get("X-Alraesy-Employee-Preview");
    if(!token){next();return;}
    const match=/^([1-9]\d*):([1-9]\d*)$/.exec(token);
    if(!match){next(new HttpError(400,"invalid_preview","اختيار المعاينة غير صالح"));return;}
    if(!req.auth?.user.owner){
      next(new HttpError(403,"preview_owner_only","معاينة صلاحيات الموظفين متاحة للمالك فقط"));return;
    }
    if(req.method!=="GET" && req.method!=="HEAD"){
      next(new HttpError(403,"preview_read_only","المعاينة للقراءة فقط؛ عد إلى حساب المالك للتعديل"));return;
    }
    const companyId=Number(match[1]),employeeId=Number(match[2]);
    if(!Number.isSafeInteger(companyId)||!Number.isSafeInteger(employeeId)){
      next(new HttpError(400,"invalid_preview","اختيار المعاينة غير صالح"));return;
    }
    // A preview cannot expand beyond its own company, nor read arbitrary
    // public/owner APIs with the elevated real owner cookie.
    const scopedCompany=new RegExp("^/companies/"+companyId+"(?:/|$)").test(req.path);
    const scopedCatalog=/^\/page-catalog(?:\/|$)/.test(req.path) &&
      req.query.companyId===String(companyId);
    if(!scopedCompany&&!scopedCatalog){
      next(new HttpError(403,"preview_scope","في المعاينة تُعرض صفحات الشركة المختارة فقط"));return;
    }
    pool.query(
      "SELECT u.* FROM employees e JOIN users u ON u.id=e.user_id"+
      " WHERE e.id=$1 AND e.company_id=$2 AND e.active AND NOT u.archived"+
      " AND NOT u.suspended LIMIT 1",
      [employeeId,companyId],
    ).then(result=>{
      if(!result.rowCount){
        next(new HttpError(403,"preview_inactive","الموظف غير نشط أو غير تابع للشركة"));return;
      }
      // Only the effective identity used for GET authorization changes.
      // The real owner's cookie, CSRF and database session remain untouched.
      req.auth={...req.auth!,user:userDTO(result.rows[0])};
      next();
    }).catch(next);
  };
}

import { initializeCompanyAccounts } from "./routes-accounts.ts";
import { initializeCompanyCurrencies } from "./routes-currencies.ts";
import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import {
  companySchema,
  companyPatchSchema,
  employeeSchema,
  employeePatchSchema,
  employeeRoles,
  employeePositionKeys,
  managerSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { actor, handler, id, parse } from "./http.ts";
import { audit } from "./services/audit.ts";
import { awardCompanyDailyLogin } from "./services/wallet-login.ts";
import { passwordHash } from "./services/auth.ts";
import { assertPhoneAvailable } from "./services/phone-identity.ts";
import { provisionEmployeeAccounts, employeeAccountsSnapshot, completeEmployeeAccounts } from "./services/employee-accounts.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import {
  currentActor,
  ownerOnly,
  companyAccess,
  manageEmployees,
} from "./policies/access.ts";
import {
  companyDTO,
  employeeDTO,
  employeeSelect,
  userDTO,
} from "./repositories/models.ts";
import { accountDTO, accountSelect, branchDTO, locationDTO } from "./repositories/masters.ts";
import { auditPage } from "./routes-public.ts";
import { deny, missing, HttpError } from "./errors.ts";

export function companyRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies",
    handler(async (req, res) => {
      const query = listQuery(req.query, {
        id: "c.id",
        name: "c.name",
        phone: "c.phone",
        address: "c.address",
        createdAt: "c.created_at",
      });
      const page = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const access = user.owner
          ? "true"
          : "EXISTS(SELECT 1 FROM employees e WHERE e.company_id=c.id AND e.user_id=$1 AND e.active)";
        const accessible = await client.query(
          `SELECT c.id FROM companies c WHERE ${access} ORDER BY c.id`,
          user.owner ? [] : [user.id],
        );
        const stored = await client.query(
          "SELECT last_company_id FROM users WHERE id=$1",
          [user.id],
        );
        const previous: number | null = stored.rows[0].last_company_id;
        const lastCompanyId = accessible.rows.some(
          (company) => company.id === previous,
        )
          ? previous
          : (accessible.rows[0]?.id ?? null);
        if (previous !== lastCompanyId) {
          await client.query(
            "UPDATE users SET last_company_id=$1 WHERE id=$2",
            [lastCompanyId, user.id],
          );
          await audit(
            client,
            user,
            "company.lastFallback",
            "user",
            user.id,
            { lastCompanyId: previous },
            { lastCompanyId },
          );
        }
        const parameters: unknown[] = user.owner
          ? [searchPattern(query.q)]
          : [user.id, searchPattern(query.q)];
        const qIndex = user.owner ? 1 : 2,
          filter = `(${access}) AND (c.name ILIKE $${qIndex} OR c.phone ILIKE $${qIndex} OR c.address ILIKE $${qIndex})`;
        const count = await client.query(
          `SELECT count(*)::integer AS total FROM companies c WHERE ${filter}`,
          parameters,
        );
        const rows = await client.query(
          `SELECT c.* FROM companies c WHERE ${filter} ORDER BY ${query.order} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
          [...parameters, query.pageSize, query.offset],
        );
        return {
          items: rows.rows.map(companyDTO),
          total: count.rows[0].total,
          page: query.page,
          pageSize: query.pageSize,
          lastCompanyId,
        };
      });
      res.json(page);
    }),
  );
  router.post(
    "/companies",
    handler(async (req, res) => {
      const input = parse(companySchema, req.body);
      const company = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        const result = await client.query(
          "INSERT INTO companies(name,phone,address,created_by) VALUES($1,$2,$3,$4) RETURNING *",
          [input.name, input.phone, input.address, user.id],
        );
        const next = companyDTO(result.rows[0]);
        await initializeCompanyAccounts(client, user, next.id);
        await initializeCompanyCurrencies(client, user, next.id);
        // Add default staff/payroll/operating accounts and prepare a nullable
        // reward conversion policy. No wages or monetary reward is posted.
        await client.query(
          "SELECT ensure_company_operational_accounts($1,$2)",
          [next.id, user.id],
        );
        await client.query(
          "SELECT initialize_company_inventory_settings($1,$2)",
          [next.id, user.id],
        );
        await audit(
          client,
          user,
          "company.create",
          "company",
          next.id,
          null,
          next,
          next.id,
        );
        // Every new company starts with an active main branch and its showroom.
        // Keep all three inserts and audit events in one transaction: no partial company.
        const mainBranchResult = await client.query(
          "INSERT INTO branches(company_id,code,name,phone,address,active,created_by) VALUES($1,'HQ','الفرع الرئيسي',$2,$3,true,$4) RETURNING *",
          [next.id, next.phone, next.address, user.id],
        );
        const mainBranch = branchDTO(mainBranchResult.rows[0]);
        const showroomResult = await client.query(
          "INSERT INTO locations(company_id,branch_id,code,name,kind,active,created_by) VALUES($1,$2,'SHOWROOM','المعرض','showroom',true,$3) RETURNING *",
          [next.id, mainBranch.id, user.id],
        );
        const showroom = locationDTO({
          ...showroomResult.rows[0],
          branch_name: mainBranch.name,
          branch_active: mainBranch.active,
        });
        await audit(
          client,
          user,
          "branch.create",
          "branch",
          mainBranch.id,
          null,
          mainBranch,
          next.id,
        );
        await audit(
          client,
          user,
          "location.create",
          "location",
          showroom.id,
          null,
          showroom,
          next.id,
        );
        return next;
      });
      res.status(201).json({ company });
    }),
  );
  router.get(
    "/companies/:companyId",
    handler(async (req, res) => {
      const user = actor(req),
        companyId = id(req.params.companyId);
      const context = await companyAccess(pool, user, companyId);
      await audit(
        pool,
        user,
        "company.view",
        "company",
        companyId,
        null,
        null,
        companyId,
      );
      res.json(context);
    }),
  );
  router.patch(
    "/companies/:companyId",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        input = parse(companyPatchSchema, req.body);
      const context = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const access = await companyAccess(
          client,
          user,
          companyId,
          "company.edit",
          true,
        );
        await assertRequestPagesEnabled(client, req, true);
        const after = { ...access.company, ...input };
        const result = await client.query(
          "UPDATE companies SET name=$1,phone=$2,address=$3 WHERE id=$4 RETURNING *",
          [after.name, after.phone, after.address, companyId],
        );
        const next = companyDTO(result.rows[0]);
        await audit(
          client,
          user,
          "company.update",
          "company",
          companyId,
          access.company,
          next,
          companyId,
        );
        return { ...access, company: next };
      });
      res.json(context);
    }),
  );

  // Company masthead is a separate setting, never included in accounting records.
  // Employees may view it for printing, but only the creator or platform owner
  // may replace or clear the artwork.
  router.get("/companies/:companyId/letterhead", handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const user=await currentActor(pool,actor(req),false);
    await companyAccess(pool,user,companyId);
    const result=await pool.query(
      "SELECT media_id,updated_at FROM company_letterheads WHERE company_id=$1",
      [companyId],
    );
    const row=result.rows[0];
    res.json({
      mediaId:row?.media_id??null,
      imageUrl:row?.media_id?`/api/media/${row.media_id}/full`:null,
      updatedAt:row?.updated_at?.toISOString()??null,
    });
  }));
  router.put("/companies/:companyId/letterhead",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const {mediaId}=parse(
      z.object({mediaId:z.uuid().nullable()}).strict(),req.body,
    );
    const result=await transaction(pool,async(client)=>{
      const user=await currentActor(client,actor(req));
      const access=await companyAccess(client,user,companyId,undefined,true);
      if(!user.owner && access.company.createdBy!==user.id)
        throw new HttpError(403,"forbidden","تعديل الترويسة متاح لمالك الشركة فقط");
      const previous=await client.query(
        "SELECT media_id FROM company_letterheads WHERE company_id=$1",
        [companyId],
      );
      if(mediaId!==null){
        const asset=await client.query(
          "SELECT id FROM media_assets WHERE id=$1 AND company_id=$2 AND purpose='letterhead'",
          [mediaId,companyId],
        );
        if(!asset.rowCount) throw new HttpError(400,"invalid_image","الصورة غير مخصصة لهذه الشركة أو ليست ترويسة");
        await client.query(
          `INSERT INTO company_letterheads(company_id,media_id,updated_by)
           VALUES($1,$2,$3)
           ON CONFLICT(company_id) DO UPDATE SET
             media_id=EXCLUDED.media_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [companyId,mediaId,user.id],
        );
      }else{
        await client.query("DELETE FROM company_letterheads WHERE company_id=$1",[companyId]);
      }
      await audit(
        client,user,"company.letterhead.update","company",companyId,
        {mediaId:previous.rows[0]?.media_id??null},{mediaId},companyId,
      );
      return {
        mediaId,
        imageUrl:mediaId?`/api/media/${mediaId}/full`:null,
      };
    });
    res.json(result);
  }));

  router.post(
    "/companies/:companyId/activate",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        await companyAccess(client, user, companyId, undefined, true);
        const previous = await client.query(
          "SELECT last_company_id FROM users WHERE id=$1",
          [user.id],
        );
        await client.query("UPDATE users SET last_company_id=$1 WHERE id=$2", [
          companyId,
          user.id,
        ]);
        await audit(
          client,
          user,
          "company.activate",
          "user",
          user.id,
          { lastCompanyId: previous.rows[0].last_company_id },
          { lastCompanyId: companyId },
          companyId,
        );
        // Same transaction: a failed ledger write cannot silently lose the reward.
        // Not a global login reward: only the company actually opened is credited.
        await awardCompanyDailyLogin(client, companyId, user);
      });
      res.json({ ok: true, lastCompanyId: companyId });
    }),
  );
  router.get(
    "/companies/:companyId/users/search",
    handler(async (req, res) => {
      const user = actor(req),
        companyId = id(req.params.companyId);
      const context = await companyAccess(pool, user, companyId);
      manageEmployees(user, context);
      if (
        typeof req.query.q !== "string" ||
        !req.query.q.trim() ||
        req.query.q.length > 254
      )
        throw new HttpError(
          400,
          "invalid_query",
          "اكتب بريدًا أو هاتفًا كاملًا",
        );
      const search = req.query.q.trim().toLowerCase(),
        phone = search
          .replace(/[\s()\-]/g, "")
          .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
      const found = await pool.query(
        "SELECT * FROM users WHERE NOT archived AND (email=$1 OR (phone<>'' AND phone=$2)) ORDER BY id LIMIT 20",
        [search, phone],
      );
      res.json({ items: found.rows.map(userDTO) });
    }),
  );
  // A signed-in employee may read ONLY their own linked, active sales
  // cash account, independent of the employee-directory permission.
  // Never infer cashbox ownership from the name or an unrelated account.
  router.get(
    "/companies/:companyId/my-sales-cashbox",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const context = await companyAccess(pool, actor(req), companyId);
      if (!context.employee) {
        res.json({ account: null });
        return;
      }
      const result = await pool.query(
        `${accountSelect}
         JOIN employee_account_links l
           ON l.company_id=a.company_id AND l.account_id=a.id
         WHERE l.company_id=$1 AND l.employee_id=$2
           AND l.account_kind='sales_cash'
           AND a.active=true AND a.kind='posting' AND a.cash_or_bank=true
         LIMIT 1`,
        [companyId, context.employee.id],
      );
      res.json({ account: result.rows[0] ? accountDTO(result.rows[0]) : null });
    }),
  );
  router.get(
    "/companies/:companyId/employees",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      await companyAccess(pool, actor(req), companyId, "employees.view");
      const query = listQuery(req.query, {
        id: "e.id",
        name: "e.name",
        displayName: "u.display_name",
        email: "u.email",
        phone: "e.phone",
        role: "e.role",
        active: "e.active",
        isGeneralManager: "e.is_general_manager",
        createdAt: "e.created_at",
      });
      const parameters: unknown[] = [companyId, searchPattern(query.q)];
      let filter =
        "e.company_id=$1 AND (e.name ILIKE $2 OR e.phone ILIKE $2 OR u.email ILIKE $2 OR u.display_name ILIKE $2)";
      if (req.query.role !== undefined) {
        if (
          typeof req.query.role !== "string" ||
          !employeeRoles.includes(
            req.query.role as (typeof employeeRoles)[number],
          )
        )
          throw new HttpError(400, "invalid_query", "الدور غير صالح");
        parameters.push(req.query.role);
        filter += ` AND e.role=$${parameters.length}`;
      }
      if (req.query.position !== undefined) {
        const position=req.query.position;
        if(typeof position!=="string"||!(employeePositionKeys as readonly string[]).includes(position))
          throw new HttpError(400,"invalid_query","صفة الموظف غير معرّفة");
        parameters.push(position);
        filter += " AND $"+parameters.length+"=ANY(e.position_keys)";
      }
      if (req.query.active !== undefined) {
        if (!["true", "false"].includes(String(req.query.active)))
          throw new HttpError(400, "invalid_query", "الحالة غير صالحة");
        parameters.push(req.query.active === "true");
        filter += ` AND e.active=$${parameters.length}`;
      }
      const count = await pool.query(
        `SELECT count(*)::integer AS total FROM employees e JOIN users u ON u.id=e.user_id WHERE ${filter}`,
        parameters,
      );
      const rows = await pool.query(
        `${employeeSelect} WHERE ${filter} ORDER BY ${query.order} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
        [...parameters, query.pageSize, query.offset],
      );
      res.json({
        items: rows.rows.map(employeeDTO),
        total: count.rows[0].total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
  );
  router.post(
    "/companies/:companyId/employees",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        input = parse(employeeSchema, req.body);
      const createdEmployee = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const context = await companyAccess(
          client,
          user,
          companyId,
          undefined,
          true,
        );
        manageEmployees(user, context);
        await assertRequestPagesEnabled(client, req, true);
        const target = await client.query(
          "SELECT * FROM users WHERE id=$1 FOR SHARE",
          [input.userId ?? 0],
        );
        let targetUserId = input.userId ?? 0;
        if (input.newUser) {
          ownerOnly(user);
          await assertPhoneAvailable(client, input.newUser.phone);
          const secretHash = await passwordHash(input.newUser.password);
          const createdUser = await client.query(
            "INSERT INTO users(name,display_name,phone,email,phone_login_key,password_hash) VALUES($1,$2,$3,$4,$3,$5) RETURNING *",
            [input.newUser.name, input.newUser.displayName || input.newUser.name,
              input.newUser.phone, input.newUser.email, secretHash],
          );
          targetUserId = createdUser.rows[0].id;
          await audit(client, user, "user.register", "user", targetUserId, null,
            userDTO(createdUser.rows[0]));
        } else {
          if (!target.rows[0]) missing("المستخدم غير موجود");
          if (target.rows[0].archived) deny("لا يمكن ربط حساب مؤرشف");
        }
        const created = await client.query(
          "INSERT INTO employees(company_id,user_id,name,phone,role,active,permissions,position_keys,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
          [
            companyId,
            targetUserId,
            input.name,
            input.phone,
            input.role,
            input.active,
            input.permissions,
            input.positions ?? [],
            user.id,
          ],
        );
        const result = await client.query(`${employeeSelect} WHERE e.id=$1`, [
          created.rows[0].id,
        ]);
        const next = employeeDTO(result.rows[0]);
        const accounts = await provisionEmployeeAccounts(
          client, user, companyId, next.id, next.name, input.createSalesCashbox,
        );
        await audit(
          client,
          user,
          "employee.create",
          "employee",
          next.id,
          null,
          next,
          companyId,
        );
        return { employee: next, accounts };
      });
      res.status(201).json(createdEmployee);
    }),
  );
  router.get(
    "/companies/:companyId/employees/:employeeId/accounts",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const employeeId = id(req.params.employeeId);
      await companyAccess(pool, actor(req), companyId, "employees.view");
      const accounts = await employeeAccountsSnapshot(pool, companyId, employeeId);
      res.json({ accounts });
    }),
  );
  router.post(
    "/companies/:companyId/employees/:employeeId/accounts",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const employeeId = id(req.params.employeeId);
      const input = parse(
        z.object({ createSalesCashbox: z.boolean().default(false) }).strict(),
        req.body,
      );
      const accounts = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const context = await companyAccess(
          client, user, companyId, undefined, true,
        );
        manageEmployees(user, context);
        return completeEmployeeAccounts(
          client, user, companyId, employeeId, input.createSalesCashbox,
        );
      });
      res.json({ accounts });
    }),
  );
  router.patch(
    "/companies/:companyId/employees/:employeeId",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        employeeId = id(req.params.employeeId),
        input = parse(employeePatchSchema, req.body);
      const employee = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const context = await companyAccess(
          client,
          user,
          companyId,
          undefined,
          true,
        );
        manageEmployees(user, context);
        await assertRequestPagesEnabled(client, req, true);
        const target = await client.query(
          "SELECT u.* FROM users u JOIN employees e ON e.user_id=u.id WHERE e.company_id=$1 AND e.id=$2 FOR SHARE OF u",
          [companyId, employeeId],
        );
        if (!target.rows[0]) missing();
        const result = await client.query(
          `${employeeSelect} WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE OF e`,
          [companyId, employeeId],
        );
        if (!result.rows[0]) missing();
        const before = employeeDTO(result.rows[0]);
        if (before.isGeneralManager && !user.owner)
          deny("تعديل المدير العام للمالك فقط");
        if (input.active === true && target.rows[0].archived)
          deny("لا يمكن تفعيل موظف مرتبط بحساب مؤرشف");
        const after = { ...before, ...input };
        await client.query(
          "UPDATE employees SET name=$1,phone=$2,role=$3,active=$4,permissions=$5,position_keys=$6 WHERE company_id=$7 AND id=$8",
          [
            after.name,
            after.phone,
            after.role,
            after.active,
            after.permissions,
            after.positions,
            companyId,
            employeeId,
          ],
        );
        const updated = await client.query(
          `${employeeSelect} WHERE e.company_id=$1 AND e.id=$2`,
          [companyId, employeeId],
        );
        const next = employeeDTO(updated.rows[0]);
        await audit(
          client,
          user,
          "employee.update",
          "employee",
          employeeId,
          before,
          next,
          companyId,
        );
        return next;
      });
      res.json({ employee });
    }),
  );
  router.patch(
    "/companies/:companyId/employees/:employeeId/manager",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        employeeId = id(req.params.employeeId),
        input = parse(managerSchema, req.body);
      const employee = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        await companyAccess(client, user, companyId, undefined, true);
        // Lock the linked identity before checking archived state, serializing with public archival.
        const target = await client.query(
          "SELECT u.* FROM users u JOIN employees e ON e.user_id=u.id WHERE e.company_id=$1 AND e.id=$2 FOR SHARE OF u",
          [companyId, employeeId],
        );
        if (!target.rows[0]) missing();
        const result = await client.query(
          `${employeeSelect} WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE OF e`,
          [companyId, employeeId],
        );
        const before = employeeDTO(result.rows[0]);
        if (
          input.isGeneralManager &&
          (!before.active || target.rows[0].archived)
        )
          deny("المدير العام يحتاج موظفًا وحسابًا فعالين");
        await client.query(
          "UPDATE employees SET is_general_manager=$1 WHERE company_id=$2 AND id=$3",
          [input.isGeneralManager, companyId, employeeId],
        );
        const updated = await client.query(
          `${employeeSelect} WHERE e.company_id=$1 AND e.id=$2`,
          [companyId, employeeId],
        );
        const next = employeeDTO(updated.rows[0]);
        await audit(
          client,
          user,
          input.isGeneralManager ? "manager.appoint" : "manager.remove",
          "employee",
          employeeId,
          before,
          next,
          companyId,
        );
        return next;
      });
      res.json({ employee });
    }),
  );
  router.get(
    "/companies/:companyId/audit",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        user = actor(req);
      await companyAccess(pool, user, companyId, "audit.view");
      const page = await auditPage(pool, req.query, companyId);
      await audit(
        pool,
        user,
        "audit.view",
        "audit",
        null,
        null,
        null,
        companyId,
      );
      res.json(page);
    }),
  );
  return router;
}

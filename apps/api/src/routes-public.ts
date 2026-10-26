import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  appearanceSchema,
  userPatchSchema,
  ownerPasswordResetSchema,
  userKinds,
  DEFAULT_APPEARANCE,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { actor, handler, id, parse } from "./http.ts";
import { audit } from "./services/audit.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import {
  currentActor,
  ownerOnly,
  publicAdmin,
  publicAudit,
  companyAccess,
} from "./policies/access.ts";
import { auditDTO, userDTO } from "./repositories/models.ts";
import { deny, missing, HttpError } from "./errors.ts";
import { passwordHash } from "./services/auth.ts";
import { emitNotification } from "./services/notifications.ts";
import { assertPhoneAvailable } from "./services/phone-identity.ts";

export function publicRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/users",
    handler(async (req, res) => {
      const user = actor(req);
      publicAdmin(user);
      const query = listQuery(req.query, {
        id: "id",
        name: "name",
        displayName: "display_name",
        email: "email",
        phone: "phone",
        kind: "kind",
        archived: "archived",
        suspended: "suspended",
        createdAt: "created_at",
      });
      const parameters: unknown[] = [searchPattern(query.q)];
      let filter =
        "(name ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)";
      if (req.query.kind !== undefined) {
        if (
          typeof req.query.kind !== "string" ||
          !userKinds.includes(req.query.kind as (typeof userKinds)[number])
        )
          throw new HttpError(400, "invalid_query", "نوع المستخدم غير صالح");
        parameters.push(req.query.kind);
        filter += ` AND kind=$${parameters.length}`;
      }
      if (req.query.archived !== undefined) {
        if (!["true", "false"].includes(String(req.query.archived)))
          throw new HttpError(400, "invalid_query", "الحالة غير صالحة");
        parameters.push(req.query.archived === "true");
        filter += ` AND archived=$${parameters.length}`;
      }
      const count = await pool.query(
        `SELECT count(*)::integer AS total FROM users WHERE ${filter}`,
        parameters,
      );
      const rows = await pool.query(
        `SELECT * FROM users WHERE ${filter} ORDER BY ${query.order} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
        [...parameters, query.pageSize, query.offset],
      );
      await audit(pool, user, "users.view", "user", null, null, null);
      res.json({
        items: rows.rows.map(userDTO),
        total: count.rows[0].total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
  );
  router.post(
    "/users/:id/password",
    handler(async (req, res) => {
      const targetId = id(req.params.id);
      const input = parse(ownerPasswordResetSchema, req.body);
      const owner = await currentActor(pool, actor(req));
      ownerOnly(owner);
      const hash = await passwordHash(input.newPassword);
      await transaction(pool, async (client) => {
        const target = await client.query(
          "SELECT id,owner FROM users WHERE id=$1 FOR UPDATE",
          [targetId],
        );
        if (!target.rows[0]) missing();
        if (target.rows[0].owner)
          deny("تغيير كلمة مرور المالك يتطلب كلمة المرور الحالية من ملفه الشخصي");
        await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, targetId]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [targetId]);
        await audit(client, owner, "auth.password", "user", targetId, null, null);
        await emitNotification(client, {
          code: "AUTH_PASSWORD_CHANGED",
          companyId: null,
          subjectUserId: targetId,
          subjectKey: `user:${targetId}`,
          eventKey: `owner-reset:${randomUUID()}`,
          message: "قام مالك المنصة بإعادة تعيين كلمة مرور حسابك. سجّل الدخول بالكلمة الجديدة، وراجع أمان حسابك إذا لم تكن تتوقع هذا التغيير.",
          href: "/profile",
        });
      });
      res.json({ ok: true });
    }),
  );
  router.patch(
    "/users/:id",
    handler(async (req, res) => {
      const targetId = id(req.params.id),
        input = parse(userPatchSchema, req.body);
      const user = await transaction(pool, async (client) => {
        const current = await currentActor(client, actor(req));
        publicAdmin(current);
        await assertRequestPagesEnabled(client, req, true);
        const found = await client.query(
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [targetId],
        );
        if (!found.rows[0]) missing();
        const before = userDTO(found.rows[0]);
        if (before.owner) deny("حساب مالك المنصة محمي");
        if (input.archived === true && !current.owner) {
          const managers = await client.query(
            "SELECT 1 FROM employees WHERE user_id=$1 AND active AND is_general_manager LIMIT 1",
            [targetId],
          );
          if (managers.rowCount) deny("أرشفة مدير عام فعال تتطلب مالك المنصة");
        }
        const afterValues = { ...before, ...input };
        if (afterValues.phone !== before.phone)
          await assertPhoneAvailable(client, afterValues.phone, before.id);
        const updated = await client.query(
          "UPDATE users SET kind=$1,archived=$2,suspended=$3,editor=$4,monitor=$5,name=$6,display_name=$7,email=$8,phone=$9,phone_login_key=CASE WHEN phone<>$9 THEN $11 ELSE phone_login_key END,phone_verified_at=CASE WHEN phone<>$9 THEN NULL ELSE phone_verified_at END WHERE id=$10 RETURNING *",
          [
            afterValues.kind,
            afterValues.archived,
            afterValues.suspended,
            afterValues.editor,
            afterValues.monitor,
            afterValues.name,
            afterValues.displayName?.trim() || afterValues.name,
            afterValues.email,
            afterValues.phone,
            targetId,
            afterValues.phone || null,
          ],
        );
        const after = userDTO(updated.rows[0]);
        if (after.archived)
          await client.query("DELETE FROM sessions WHERE user_id=$1", [
            targetId,
          ]);
        await audit(
          client,
          current,
          "user.update",
          "user",
          targetId,
          before,
          after,
        );
        if (input.archived === true) {
          const companies = await client.query(
            "SELECT company_id FROM employees WHERE user_id=$1 AND active AND is_general_manager",
            [targetId],
          );
          for (const membership of companies.rows)
            await audit(
              client,
              current,
              "manager.userArchived",
              "user",
              targetId,
              before,
              after,
              membership.company_id,
            );
        }
        return after;
      });
      res.json({ user });
    }),
  );
  router.get(
    "/audit",
    handler(async (req, res) => {
      const user = actor(req);
      publicAudit(user);
      const page = await auditPage(pool, req.query, null);
      await audit(pool, user, "audit.view", "audit", null, null, null);
      res.json(page);
    }),
  );
  router.get(
    "/appearance",
    handler(async (req, res) => {
      const user = actor(req),
        scope =
          typeof req.query.scope === "string" ? req.query.scope : "public";
      await appearanceAccess(pool, user, scope);
      const result = await pool.query(
        "SELECT mode,color FROM appearance WHERE user_id=$1 AND scope=$2",
        [user.id, scope],
      );
      res.json({
        preference: result.rows[0] ?? DEFAULT_APPEARANCE,
      });
    }),
  );
  router.patch(
    "/appearance",
    handler(async (req, res) => {
      const input = parse(appearanceSchema, req.body);
      const preference = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const companyId = await appearanceAccess(
          client,
          user,
          input.scope,
          true,
        );
        const before = await client.query(
          "SELECT mode,color FROM appearance WHERE user_id=$1 AND scope=$2 FOR UPDATE",
          [user.id, input.scope],
        );
        const next = { mode: input.mode, color: input.color };
        await client.query(
          "INSERT INTO appearance(user_id,scope,mode,color) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,scope) DO UPDATE SET mode=EXCLUDED.mode,color=EXCLUDED.color",
          [user.id, input.scope, input.mode, input.color],
        );
        await audit(
          client,
          user,
          "appearance.update",
          "appearance",
          user.id,
          before.rows[0] ?? DEFAULT_APPEARANCE,
          next,
          companyId,
        );
        return next;
      });
      res.json({ preference });
    }),
  );
  return router;
}
async function appearanceAccess(
  db: import("./db.ts").Database,
  user: import("../../../packages/contracts/src/index.ts").User,
  scope: string,
  lock = false,
): Promise<number | null> {
  if (scope === "public") return null;
  if (!/^company:[1-9][0-9]*$/.test(scope))
    throw new HttpError(400, "invalid_scope", "النطاق غير صالح");
  const companyId = id(scope.slice(8));
  await companyAccess(db, user, companyId, undefined, lock);
  return companyId;
}
export async function auditPage(
  pool: import("./db.ts").Database,
  queryInput: Record<string, unknown>,
  companyId: number | null,
) {
  const query = listQuery(
    queryInput,
    {
      id: "a.id",
      actorName: "a.actor_name",
      action: "a.action",
      targetType: "a.target_type",
      targetId: "a.target_id",
      createdAt: "a.created_at",
    },
    "id:desc",
  );
  const parameters: unknown[] = [companyId, searchPattern(query.q)];
  let filter =
    "a.company_id IS NOT DISTINCT FROM $1 AND (a.action ILIKE $2 OR a.actor_name ILIKE $2 OR a.target_type ILIKE $2)";
  if (queryInput.action !== undefined) {
    if (typeof queryInput.action !== "string" || queryInput.action.length > 100)
      throw new HttpError(400, "invalid_query", "الإجراء غير صالح");
    parameters.push(queryInput.action);
    filter += ` AND a.action=$${parameters.length}`;
  }
  const count = await pool.query(
    `SELECT count(*)::integer AS total FROM audit_events a WHERE ${filter}`,
    parameters,
  );
  const result = await pool.query(
    `SELECT a.* FROM audit_events a WHERE ${filter} ORDER BY ${query.order} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
    [...parameters, query.pageSize, query.offset],
  );
  return {
    items: result.rows.map(auditDTO),
    total: count.rows[0].total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

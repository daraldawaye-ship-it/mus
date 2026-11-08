import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  appearanceSchema,
  ownerUserSchema,
  userPatchSchema,
  ownerPasswordResetSchema,
  userKinds,
  DEFAULT_APPEARANCE,
  documentDateSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { assertRequestPagesEnabled, directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
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
import { passwordHash, tokenHash } from "./services/auth.ts";
import { emitNotification } from "./services/notifications.ts";
import { assertPhoneAvailable } from "./services/phone-identity.ts";
import { recordUserPresence } from "./services/user-presence.ts";
import { recordDeviceActivity, recordReportedPushPermission, requestDevice } from "./services/user-device-activity.ts";

export function publicRoutes(pool: Pool): Router {
  const router = Router();
  // Lightweight foreground activity signal; never infer attendance from it.
  router.post("/presence/heartbeat", handler(async (req, res) => {
    const user = actor(req);
    await recordUserPresence(pool, user.id);
    // Foreground heartbeat only: never infer a person's activity from polling,
    // background HTTP requests or the last login timestamp.
    await recordDeviceActivity(pool,user.id,requestDevice(req)).catch(() => {});
    const notificationPermission = req.body?.notificationPermission;
    if (notificationPermission === "granted" || notificationPermission === "denied" ||
        notificationPermission === "default" || notificationPermission === "unsupported") {
      await recordReportedPushPermission(pool,user.id,requestDevice(req),notificationPermission)
        .catch(() => {});
    }
    res.json({ ok: true });
  }));
  // Presence aggregates authenticated general and company activity, never attendance.
  // Only site owner/admin can view other users' last activity.
  router.get("/users/last-present", handler(async (req, res) => {
    // A specifically granted view permission works for non-admin users too.
    // Managing public users remains governed by the separate admin-only API.
    const entry = (await directoryEntries(pool, actor(req), null))
      .find(page => page.key === "public.last-present");
    if (!entry) deny("الصفحة غير مسجلة في دليل الصفحات");
    assertDirectoryAccess(entry);
    const rows = await pool.query(`
      SELECT u.id,COALESCE(NULLIF(u.display_name,''),u.name) AS name,
        p.last_seen_at
      FROM users u LEFT JOIN user_presence p ON p.user_id=u.id
      WHERE NOT u.archived
      ORDER BY p.last_seen_at DESC NULLS LAST,u.id
      LIMIT 1000`);
    res.json({ items: rows.rows.map(row=>({
      id: row.id,
      name: row.name,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    })) });
  }));
  // Owner-created public identities do not implicitly become company employees.
  router.post("/users", handler(async (req, res) => {
    const input = parse(ownerUserSchema, req.body);
    const created = await transaction(pool, async client => {
      const owner = await currentActor(client, actor(req));
      ownerOnly(owner);
      await assertRequestPagesEnabled(client, req, true);
      await assertPhoneAvailable(client, input.phone);
      const secretHash = await passwordHash(input.password);
      const result = await client.query(
        "INSERT INTO users(name,display_name,phone,email,phone_login_key,password_hash) VALUES($1,$2,$3,$4,$3,$5) RETURNING *",
        [input.name, input.displayName || input.name, input.phone, input.email, secretHash],
      );
      const newUser = userDTO(result.rows[0]);
      await audit(client, owner, "user.register", "user", newUser.id, null, newUser);
      return newUser;
    });
    res.status(201).json({ user: created });
  }));
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
        editor: "editor",
        monitor: "monitor",
        owner: "owner",
        "device-activity-desktop_browser": "(SELECT a.last_activity_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='desktop_browser')",
        "device-activity-mobile_browser": "(SELECT a.last_activity_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='mobile_browser')",
        "device-activity-android_app": "(SELECT a.last_activity_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='android_app')",
        "device-activity-iphone_app": "(SELECT a.last_activity_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='iphone_app')",
        "app-push": "(SELECT max(a.last_push_confirmed_at) FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind IN ('android_app','iphone_app'))",
        "laptop-push": "(SELECT a.last_push_confirmed_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='desktop_browser')",
        createdAt: "created_at",
      }, "id:asc", new Set([
        "device-activity-desktop_browser","device-activity-mobile_browser",
        "device-activity-android_app","device-activity-iphone_app",
        "app-push","laptop-push",
      ]));
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
      // Keep the identity list query independent from optional device telemetry.
      // A stale migration or unavailable push table must never break /users.
      const rows = await pool.query(
        `SELECT * FROM users WHERE ${filter} ORDER BY ${query.order}
         LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
        [...parameters, query.pageSize, query.offset],
      );
      const userIds = rows.rows.map(row => Number(row.id));
      const deviceByUser = new Map<number, Record<string, {
        lastLoginAt: Date | null;
        lastActivityAt: Date | null;
        lastPushConfirmedAt: Date | null;
        lastPushPermission: string | null;
        lastPushPermissionCheckedAt: Date | null;
      }>>();
      const pushByUser = new Map<number, string[]>();
      if (userIds.length) {
        try {
          const activity = await pool.query(
            `SELECT user_id,device_kind,last_login_at,last_activity_at,last_push_confirmed_at,
                    last_push_permission,last_push_permission_checked_at
               FROM user_device_activity
               WHERE user_id=ANY($1::integer[])`,
            [userIds],
          );
          for (const item of activity.rows) {
            const id = Number(item.user_id);
            const kinds = deviceByUser.get(id) ?? {};
            kinds[item.device_kind] = {
              lastLoginAt: item.last_login_at,
              lastActivityAt: item.last_activity_at,
              lastPushConfirmedAt: item.last_push_confirmed_at,
              lastPushPermission: item.last_push_permission,
              lastPushPermissionCheckedAt: item.last_push_permission_checked_at,
            };
            deviceByUser.set(id, kinds);
          }
          const push = await pool.query(
            `SELECT DISTINCT p.user_id,p.device_kind
             FROM web_push_subscriptions p
             JOIN sessions ss ON ss.token_hash=p.session_hash
               AND ss.user_id=p.user_id AND ss.expires_at>clock_timestamp()
             WHERE p.user_id=ANY($1::integer[]) AND p.device_kind IS NOT NULL`,
            [userIds],
          );
          for (const item of push.rows) {
            const id = Number(item.user_id);
            const kinds = pushByUser.get(id) ?? [];
            kinds.push(item.device_kind);
            pushByUser.set(id,kinds);
          }
        } catch (error) {
          console.warn("USER_DEVICE_TELEMETRY_UNAVAILABLE",
            error instanceof Error ? error.message : "unknown");
        }
      }
      await audit(pool, user, "users.view", "user", null, null, null);
      res.json({
        items: rows.rows.map(row=>({
          ...userDTO(row),
          deviceActivity: deviceByUser.get(Number(row.id)) ?? {},
          activePushDevices: pushByUser.get(Number(row.id)) ?? [],
        })),
        total: count.rows[0].total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
  );
  // Owner-issued one-hour access links are bearer credentials, not account
  // passwords. Generate only on demand; store only SHA-256 and rotate any
  // older outstanding link for this same recipient.
  router.post("/users/:id/login-link", handler(async (req, res) => {
    const owner = await currentActor(pool,actor(req));
    ownerOnly(owner);
    const targetId = id(req.params.id);
    const rawToken = randomBytes(32).toString("base64url");
    const issued = await transaction(pool,async client => {
      const target = await client.query(
        "SELECT id,archived,owner FROM users WHERE id=$1 FOR UPDATE",
        [targetId]);
      if (!target.rowCount) missing();
      if (target.rows[0].owner) deny("رابط دخول المالك غير متاح لهذا الإجراء");
      if (target.rows[0].archived) deny("لا يمكن إنشاء رابط دخول لحساب مؤرشف");
      const result = await client.query(`
        INSERT INTO user_login_links(user_id,token_hash,issued_by,issued_at,expires_at)
        VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')
        ON CONFLICT(user_id) DO UPDATE
        SET token_hash=EXCLUDED.token_hash,issued_by=EXCLUDED.issued_by,
            issued_at=EXCLUDED.issued_at,expires_at=EXCLUDED.expires_at
        RETURNING expires_at`,
        [targetId,tokenHash(rawToken),owner.id]);
      await audit(client,owner,"auth.loginLinkIssue","user",targetId,null,
        { expiresAt: result.rows[0].expires_at.toISOString() });
      return result.rows[0].expires_at as Date;
    });
    res.setHeader("Cache-Control","no-store");
    res.json({ token:rawToken, expiresAt:issued.toISOString() });
  }));
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
        await client.query("UPDATE visitor_phone_accounts SET default_password_active=false WHERE user_id=$1", [targetId]);
        await client.query("DELETE FROM user_login_links WHERE user_id=$1", [targetId]);
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
    "createdAt:desc,id:desc",
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
  // Inclusive Yemen-local dates, independent of server/browser time zone.
  // Use timestamp bounds so audit_events.created_at can use its index.
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  for (const key of ["dateFrom","dateTo"] as const) {
    const value = queryInput[key];
    if (value === undefined || value === "") continue;
    const date = parse(documentDateSchema,value);
    if (key === "dateFrom") dateFrom = date;
    else dateTo = date;
    parameters.push(date);
    filter += key === "dateFrom"
      ? ` AND a.created_at >= (${parameters.length}::date::timestamp AT TIME ZONE 'Asia/Aden')`
      : ` AND a.created_at < ((${parameters.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Aden')`;
  }
  if (dateFrom && dateTo && dateFrom > dateTo)
    throw new HttpError(400,"invalid_query","تاريخ البداية بعد تاريخ النهاية");
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

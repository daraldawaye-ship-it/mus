import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction, type Database } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { requestDevice } from "./services/user-device-activity.ts";
import { audit } from "./services/audit.ts";
import { HttpError, missing } from "./errors.ts";

const discoverySchema = z.object({
  deviceId: z.string().uuid(),
}).strict();
const editSchema = z.object({
  name: z.string().trim().max(80),
  category: z.enum(["unclassified", "pharmacy", "employee"]),
  approved: z.boolean(),
  revision: z.number().int().positive(),
}).strict();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  q: z.string().trim().max(80).optional().default(""),
}).strict();

// UA is a display hint only. Do not collect hardware identifiers, IP or location.
export function summarizeDeviceAgent(raw: string): { browser: string; os: string } {
  const agent = raw.slice(0, 512);
  const browser = /EdgA?\/|EdgiOS\//.test(agent) ? "Edge" :
    /OPR\/|Opera\//.test(agent) ? "Opera" :
    /Firefox\/|FxiOS\//.test(agent) ? "Firefox" :
    /Chrome\/|CriOS\//.test(agent) ? "Chrome" :
    /Safari\//.test(agent) ? "Safari" : "متصفح غير معروف";
  const os = /Android/i.test(agent) ? "Android" :
    /iPhone|iPad|iPod/i.test(agent) ? "iOS / iPadOS" :
    /Windows/i.test(agent) ? "Windows" :
    /Macintosh|Mac OS/i.test(agent) ? "macOS" :
    /Linux/i.test(agent) ? "Linux" : "غير معروف";
  return { browser, os };
}

async function checkDevicePage(pool: Database, user: ReturnType<typeof actor>, companyId: number, action: "view" | "edit") {
  await companyAccess(pool, user, companyId);
  const entry = (await directoryEntries(pool, user, companyId))
    .find((item) => item.key === "company.approved-devices");
  if (!entry) missing("صفحة الأجهزة غير مسجلة");
  assertDirectoryAccess(entry, action);
}

export function companyDeviceRoutes(pool: Pool): Router {
  const router = Router();

  // Called by authenticated company visitors. Recognition NEVER controls access.
  router.post("/companies/:companyId/approved-devices/discover", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const user = await currentActor(pool, actor(req));
    const { deviceId } = parse(discoverySchema, req.body);
    const identityHash = createHash("sha256").update(deviceId).digest("hex");
    const { browser, os } = summarizeDeviceAgent(req.get("user-agent") ?? "");
    const kind = requestDevice(req);
    const recordId = await transaction(pool, async (client) => {
      await companyAccess(client, user, companyId);
      const device = await client.query(
        "INSERT INTO company_known_devices " +
        "(company_id,identity_hash,device_kind,browser,operating_system,first_user_id,last_user_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$6) " +
        "ON CONFLICT(company_id,identity_hash) DO UPDATE SET " +
        "device_kind=EXCLUDED.device_kind,browser=EXCLUDED.browser,operating_system=EXCLUDED.operating_system, " +
        "last_user_id=EXCLUDED.last_user_id, " +
        "last_seen_at=clock_timestamp() " +
        "RETURNING id",
        [companyId, identityHash, kind, browser, os, user.id],
      );
      const deviceRowId = device.rows[0].id as string;
      await client.query(
        "INSERT INTO company_known_device_users(device_id,user_id) VALUES($1,$2) " +
        "ON CONFLICT(device_id,user_id) DO UPDATE SET last_seen_at=clock_timestamp()",
        [deviceRowId, user.id],
      );
      return deviceRowId;
    });
    res.json({ ok: true, id: recordId });
  }));

  router.get("/companies/:companyId/approved-devices", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const user = await currentActor(pool, actor(req), false);
    const input = parse(listSchema, req.query);
    await checkDevicePage(pool, user, companyId, "view");
    const pattern = "%" + input.q + "%";
    const params = [companyId, pattern];
    const where = "d.company_id=$1 AND " +
      "($2='%%' OR d.label ILIKE $2 OR d.browser ILIKE $2 OR d.operating_system ILIKE $2 " +
      "OR COALESCE(NULLIF(u.display_name,''),u.name) ILIKE $2)";
    const count = await pool.query(
      "SELECT count(*)::integer AS total FROM company_known_devices d " +
      "LEFT JOIN users u ON u.id=d.last_user_id WHERE " + where, params,
    );
    const result = await pool.query(
      "SELECT d.id,d.label AS name,d.category,d.approved,d.device_kind AS \"deviceKind\"," +
      "d.browser,d.operating_system AS \"operatingSystem\",d.revision," +
      "d.first_seen_at AS \"firstSeenAt\",d.last_seen_at AS \"lastSeenAt\"," +
      "d.last_user_id AS \"lastUserId\"," +
      "COALESCE(NULLIF(u.display_name,''),u.name) AS \"lastUserName\"," +
      "(SELECT count(*)::integer FROM company_known_device_users du WHERE du.device_id=d.id) AS \"userCount\" " +
      "FROM company_known_devices d LEFT JOIN users u ON u.id=d.last_user_id WHERE " + where +
      " ORDER BY d.last_seen_at DESC,d.id DESC LIMIT $3 OFFSET $4",
      [...params, input.pageSize, (input.page - 1) * input.pageSize],
    );
    res.json({ items: result.rows, total: count.rows[0].total, page: input.page, pageSize: input.pageSize });
  }));

  // Documentation/approval status only; no login, page, or offline enforcement.
  router.patch("/companies/:companyId/approved-devices/:deviceId", handler(async (req, res) => {
    const companyId = id(req.params.companyId), deviceId = id(req.params.deviceId);
    const input = parse(editSchema, req.body);
    const updated = await transaction(pool, async (client) => {
      const user = await currentActor(client, actor(req));
      await checkDevicePage(client, user, companyId, "edit");
      const before = await client.query(
        "SELECT * FROM company_known_devices WHERE id=$1 AND company_id=$2 FOR UPDATE",
        [deviceId, companyId],
      );
      if (!before.rows[0]) missing("الجهاز غير موجود في هذه الشركة");
      if (before.rows[0].revision !== input.revision)
        throw new HttpError(409, "conflict", "تغيّرت بيانات الجهاز؛ حدّث القائمة ثم حاول مجددًا");
      const changed = await client.query(
        "UPDATE company_known_devices SET label=$1,category=$2,approved=$3,revision=revision+1 " +
        "WHERE id=$4 AND company_id=$5 RETURNING *",
        [input.name, input.category, input.approved, deviceId, companyId],
      );
      await audit(client, user, "company.device.update", "company_device", deviceId,
        { name: before.rows[0].label, category: before.rows[0].category, approved: before.rows[0].approved },
        { name: input.name, category: input.category, approved: input.approved }, companyId);
      return changed.rows[0];
    });
    res.json({ id: updated.id, revision: updated.revision, updated: true });
  }));
  return router;
}

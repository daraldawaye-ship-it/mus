import type { Request } from "express";
import type { Database } from "../db.ts";

export type DeviceKind = "desktop_browser" | "mobile_browser" | "android_app" | "iphone_app";

/** Classification is informational, never used to grant access. A PWA in
 * standalone mode sends a hint; UA alone cannot distinguish it from a tab. */
export function classifyDevice(userAgent: string, hint?: string): DeviceKind {
  const appleMobile = /iPhone|iPad|iPod/i.test(userAgent);
  const android = /Android/i.test(userAgent);
  const mobile = appleMobile || android || /Mobile|Mobi/i.test(userAgent);
  if (hint === "iphone_app" && appleMobile) return "iphone_app";
  if (hint === "android_app" && android) return "android_app";
  return mobile ? "mobile_browser" : "desktop_browser";
}

export function requestDevice(req: Request): DeviceKind {
  return classifyDevice(req.get("user-agent") ?? "", req.get("x-alraesy-device"));
}

export async function recordDeviceLogin(
  db: Database, req: Request, userId: number,
): Promise<void> {
  await db.query(`
    INSERT INTO user_device_activity(user_id,device_kind,last_login_at)
    VALUES($1,$2,clock_timestamp())
    ON CONFLICT(user_id,device_kind) DO UPDATE
    SET last_login_at=EXCLUDED.last_login_at`,
    [userId,requestDevice(req)]);
}

/** A server-accepted subscription confirmation, not proof that the device
 * still allows notifications or that a push was delivered. */
export async function recordPushConfirmation(
  db: Database, userId: number, kind: DeviceKind,
): Promise<void> {
  await db.query(`
    INSERT INTO user_device_activity(user_id,device_kind,last_push_confirmed_at)
    VALUES($1,$2,clock_timestamp())
    ON CONFLICT(user_id,device_kind) DO UPDATE
    SET last_push_confirmed_at=EXCLUDED.last_push_confirmed_at`,
    [userId,kind]);
}

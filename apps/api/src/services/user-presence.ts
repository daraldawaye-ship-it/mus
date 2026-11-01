import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { Database } from "../db.ts";

/** One last activity timestamp per authenticated user, across every company
 * and public section. This never records which company, page or action.
 */
export async function recordUserPresence(db: Database, userId: number): Promise<void> {
  await db.query(`
    INSERT INTO user_presence(user_id,last_seen_at)
    VALUES($1,clock_timestamp())
    ON CONFLICT(user_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at
    WHERE user_presence.last_seen_at < clock_timestamp()-interval '50 seconds'`,
    [userId],
  );
}

/** Existing installed clients need not implement the new frontend heartbeat:
 * authenticated company and public API activity is captured server-side.
 * A process-local throttle prevents one database write per ordinary request.
 * Do not block any sale or other request while the activity hint is stored.
 */
export function trackAuthenticatedPresence(pool: Pool): RequestHandler {
  const lastAttempt = new Map<number, number>();
  return (req, _res, next) => {
    const userId = req.auth?.user.id;
    if (userId && req.path !== "/presence/heartbeat") {
      const now = Date.now();
      if (now - (lastAttempt.get(userId) ?? 0) >= 60_000) {
        lastAttempt.set(userId, now);
        void recordUserPresence(pool, userId).catch(() => {
          // Monitoring must never slow, fail, or roll back application actions.
        });
        if (lastAttempt.size > 10_000) {
          for (const [id, at] of lastAttempt)
            if (now - at > 10 * 60_000) lastAttempt.delete(id);
        }
      }
    }
    next();
  };
}

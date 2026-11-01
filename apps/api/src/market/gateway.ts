import { Router, type RequestHandler, type Request } from "express";
import type { Pool } from "pg";
import { currentActor } from "../policies/access.ts";
import { actor, handler } from "../http.ts";
import { HttpError } from "../errors.ts";
import { assertRequestPagesEnabled } from "../services/pages.ts";
import { marketPages, requireMarketSecret, signMarketRequest } from "./transport.ts";

export interface MarketGatewayOptions { url: string; secret: string; concurrency?: number; timeoutMs?: number; }
export function marketGatewayOptions(): MarketGatewayOptions | undefined {
  // Blueprint wires a private service hostname before cutover. Never switch automatically
  // merely because the private service exists; migration and validation come first.
  if (process.env.MARKET_SERVICE_ENABLED === "0") return undefined;
  const explicitUrl = process.env.MARKET_SERVICE_URL?.trim();
  const hostport = process.env.MARKET_SERVICE_HOSTPORT?.trim();
  const enabled = process.env.MARKET_SERVICE_ENABLED === "1";
  if (enabled && !explicitUrl && !hostport) {
    throw new Error("MARKET_SERVICE_ENABLED=1 requires MARKET_SERVICE_HOSTPORT or MARKET_SERVICE_URL");
  }
  const url = explicitUrl ?? (enabled && hostport ? `http://${hostport}` : undefined);
  if (!url) return undefined;
  return { url, secret: process.env.MARKET_SERVICE_SECRET ?? "" };
}
const unavailable = () => new HttpError(503, "market_unavailable", "سوق الأدوية غير متاح مؤقتًا؛ حاول لاحقًا");
/** This gate is shared by browser (before session lookup) and MCP dispatch. No request queue. */
export function createMarketGateway(pool: Pool, options: MarketGatewayOptions) {
  requireMarketSecret(options.secret);
  const endpoint = new URL(options.url);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("MARKET_SERVICE_URL must be a service origin");
  const max = options.concurrency ?? 8, timeoutMs = options.timeoutMs ?? 4000;
  if (!Number.isInteger(max) || max < 1 || max > 32 || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Invalid market gateway limits");
  let inflight = 0, failures = 0, openUntil = 0;
  const accepted = new WeakSet<Request>();
  const admission: RequestHandler = (req, res, next) => {
    if (accepted.has(req)) return next();
    if (inflight >= max || Date.now() < openUntil) {
      res.setHeader("Retry-After", "5");
      return next(unavailable());
    }
    accepted.add(req); inflight++;
    let released = false;
    const release = () => { if (!released) { released = true; inflight--; } };
    res.once("finish", release); res.once("close", release);
    next();
  };
  const router = Router();
  router.use("/medicine-market", admission);
  router.use("/medicine-market", handler(async (req, res) => {
    const body = ["GET", "HEAD"].includes(req.method) ? "" : JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(body) > 65536) throw new HttpError(413, "body_too_large", "حجم الطلب كبير");
    // Read current authority per request; never cache an owner's privileges in a browser token.
    const user = req.auth ? await currentActor(pool, actor(req), false) : null;
    await assertRequestPagesEnabled(pool, req);
    const settings = await pool.query("SELECT page_key FROM page_settings WHERE company_id IS NULL AND page_key=ANY($1::text[]) AND NOT enabled", [marketPages]);
    const path = "/api/medicine-market" + req.url;
    const headers = signMarketRequest(options.secret, req.method, path, user, settings.rows.map(r => r.page_key), body);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.once("close", disconnect);
    try {
      const response = await fetch(new URL(path, endpoint), {
        method: req.method, headers: { ...headers, "content-type": "application/json" },
        body: body || undefined, signal: abort.signal, redirect: "error",
      });
      // Bound retained response memory; do not forward cookies, redirects or internal headers.
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw unavailable(); }
        chunks.push(part.value);
      }
      if (response.status >= 500) { failures++; if (failures >= 3) openUntil = Date.now() + 10000; }
      else failures = 0;
      if (req.method === "HEAD") res.status(response.status).end();
      else res.status(response.status).json(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      failures++; if (failures >= 3) openUntil = Date.now() + 10000;
      // No fallback to the primary DB, and no automatic write retry after uncertain delivery.
      throw unavailable();
    } finally { clearTimeout(timer); res.off("close", disconnect); }
  }));
  return { router, admission };
}

/** Freeze the market alone during a verified one-time copy; sales remain available. */
export const marketMaintenance: RequestHandler = (_req, res, next) => {
  if (process.env.MARKET_MAINTENANCE !== "1") return next();
  res.status(503).set("Retry-After", "60").json({ error: { code: "market_maintenance", message: "سوق الأدوية في صيانة مؤقتة" } });
};

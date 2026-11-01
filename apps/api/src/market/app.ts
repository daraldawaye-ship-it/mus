import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { ZodError } from "zod";
import { medicineMarketRoutes, type MarketAccess } from "../routes-medicine-market.ts";
import { actor } from "../http.ts";
import { deny, HttpError } from "../errors.ts";
import { asUser, marketVerifier, type MarketContext } from "./transport.ts";

export function createMarketApp(pool: Pool, secret: string) {
  const app = express(), verify = marketVerifier(secret);
  const contexts = new WeakMap<express.Request, MarketContext>();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.get("/api/health", async (_req, res) => {
    try { await pool.query("SELECT 1"); res.json({ ok: true, service: "medicine-market" }); }
    catch { res.status(503).json({ ok: false }); }
  });
  // Bound requests before parsing or connecting to PostgreSQL; refuse excess work, do not queue it.
  let active = 0;
  app.use("/api/medicine-market", (_req, res, next) => {
    if (active >= 12) return res.status(503).set("Retry-After", "5").json({ error: { code: "market_busy", message: "السوق مشغول مؤقتًا" } });
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once("finish", release); res.once("close", release); next();
  });
  app.use("/api", express.text({ type: "application/json", limit: "64kb" }));
  app.use("/api", (req, _res, next) => {
    try {
      const raw = typeof req.body === "string" ? req.body : "";
      const context = verify(req.method, req.originalUrl, req.get("x-market-context") ?? "", req.get("x-market-signature") ?? "", raw);
      contexts.set(req, context);
      if (context.user) req.auth = { user: asUser(context.user), tokenHash: "", csrf: "" };
      req.body = raw ? JSON.parse(raw) : undefined;
      next();
    } catch (error) { next(error); }
  });
  const access: MarketAccess = {
    async viewer(db, req, write = false) {
      const context = contexts.get(req);
      if (!context) throw new HttpError(401, "market_auth", "طلب السوق غير معتمد");
      const user = context.user ? asUser(context.user) : null;
      if (user?.archived) throw new HttpError(401, "unauthenticated", "يرجى تسجيل الدخول");
      if (write) {
        if (!user) return actor(req);
        if (user.suspended) deny("الحساب موقوف عن المشاركة");
        // A public name snapshot only. Auth authority stays in the freshly signed request.
        await db.query("INSERT INTO users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name WHERE users.display_name IS DISTINCT FROM EXCLUDED.display_name", [user.id, user.displayName]);
      }
      return user;
    },
    async enabled(_db, req, section = "medicine-market") {
      const context = contexts.get(req);
      if (!context) throw new HttpError(401, "market_auth", "طلب السوق غير معتمد");
      if (context.disabledPages.includes("public.medicine-market") || context.disabledPages.some(key => key === `public.${section}`)) deny("هذه الصفحة موقوفة حاليًا");
    },
  };
  app.use("/api", medicineMarketRoutes(pool, access));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "المسار غير موجود" } }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError || error instanceof SyntaxError) return res.status(400).json({ error: { code: "validation", message: "تحقق من الحقول المطلوبة" } });
    const pg = error as { code?: string; type?: string };
    if (pg.type === "entity.too.large") return res.status(413).json({ error: { code: "body_too_large", message: "حجم الطلب كبير" } });
    if (["23505", "40P01", "40001"].includes(pg.code ?? "")) return res.status(409).json({ error: { code: "conflict", message: "تعارض في البيانات؛ حدّث الكرت" } });
    // Do not expose SQL, credentials or request payloads in service errors/logs.
    console.error("MARKET_REQUEST_FAILED", /^[0-9A-Z]{5}$/.test(pg.code ?? "") ? pg.code : "internal");
    return res.status(503).json({ error: { code: "market_unavailable", message: "سوق الأدوية غير متاح مؤقتًا" } });
  };
  app.use(errors);
  return app;
}

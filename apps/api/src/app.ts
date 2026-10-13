import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createDatabase } from "./db.ts";
import { configuration, type AppOptions } from "./config.ts";
import { HttpError } from "./errors.ts";
import { loadSession, mutationSecurity } from "./http.ts";
import { authRoutes } from "./routes-auth.ts";
import { setupRoutes } from "./routes-setup.ts";
import { publicRoutes } from "./routes-public.ts";
import { companyRoutes } from "./routes-companies.ts";
import { walletRoutes } from "./routes-wallet.ts";
import { notificationRoutes } from "./routes-notifications.ts";
import { attendanceRoutes } from "./routes-attendance.ts";
import { accountRoutes } from "./routes-accounts.ts";
import { currencyRoutes } from "./routes-currencies.ts";
import { locationRoutes } from "./routes-locations.ts";
import { generalTableRoutes } from "./routes-general-table.ts";
import { financeRoutes } from "./routes-finance.ts";
import { itemRoutes } from "./routes-items.ts";
import { itemImportRoutes } from "./routes-item-import.ts";
import { inventoryRoutes } from "./routes-inventory.ts";
import { commerceOptionRoutes } from "./routes-commerce-options.ts";
import { pageRoutes, pageAvailabilityGate } from "./routes-pages.ts";
import { commerceRoutes } from "./routes-commerce.ts";
import { configurationRoutes } from "./routes-configuration.ts";
import { configurationAdministrationRoutes } from "./routes-configuration-admin.ts";
import { permissionRequest } from "./services/permission-rules.ts";
import { chatgptOauthRoutes } from "./routes-chatgpt-oauth.ts";
import { socialAuthRoutes } from "./routes-social-auth.ts";
import { chatgptMcpRoutes } from "./routes-chatgpt-mcp.ts";
import { mediaRoutes } from "./routes-media.ts";

export async function createApp(options: AppOptions = {}) {
  const config = configuration(options),
    pool = await createDatabase(config.databaseUrl, config.schema);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // MCP and OAuth have dedicated bearer / PKCE / CSRF checks; they cannot use
  // the browser JSON API's Origin/CSRF middleware.
  app.use(chatgptOauthRoutes(pool, config.appOrigin, config.production));
  // External IdPs redirect here (Apple uses form_post); dedicated one-use
  // state/cookie and signed ID-token validation secure these callbacks.
  app.use("/api", socialAuthRoutes(pool, config.appOrigin, config.production));
  app.use(chatgptMcpRoutes(pool, config.appOrigin));
  app.use(
    "/api",
    express.json({ limit: "5mb" }),
    loadSession(pool),
    mutationSecurity(config.appOrigin),
  );
  app.use(setupRoutes(pool, config.appOrigin));
  app.use("/api", (req, _res, next) => permissionRequest.run(req, next));
  app.use(
    "/api",
    pageRoutes(pool),
    pageAvailabilityGate(pool),
    authRoutes(pool, config.production),
    mediaRoutes(pool),
    publicRoutes(pool),
    companyRoutes(pool),
    attendanceRoutes(pool),
    notificationRoutes(pool),
    walletRoutes(pool),
    configurationRoutes(pool),
    configurationAdministrationRoutes(pool),
    accountRoutes(pool),
    currencyRoutes(pool),
    locationRoutes(pool),
    generalTableRoutes(pool),
    financeRoutes(pool),
    itemRoutes(pool),
    itemImportRoutes(pool),
    inventoryRoutes(pool),
    commerceOptionRoutes(pool),
    commerceRoutes(pool),
  );
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ error: { code: "not_found", message: "المسار غير موجود" } }),
  );
  if (config.serveStatic) {
    const directory = resolve("dist/public");
    if (!existsSync(resolve(directory, "index.html"))) {
      await pool.end();
      throw new Error(
        "Build the client before serving static files (npm run build)",
      );
    }
    app.use(express.static(directory, { index: false }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(directory, "index.html")),
    );
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) {
      _next(error);
      return;
    }
    if (error instanceof ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join(".") || "form";
        (fields[key] ??= []).push(issue.message);
      }
      res.status(400).json({
        error: {
          code: "validation",
          message: "تحقق من الحقول المطلوبة",
          fields,
        },
      });
      return;
    }
    if (error instanceof HttpError) {
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    const pgError = error as { code?: string; type?: string; status?: number };
    if (pgError.code === "23505") {
      res.status(409).json({
        error: {
          code: "conflict",
          message: "القيمة أو الكود أو علاقة السجل موجودة بالفعل",
        },
      });
      return;
    }
    if (pgError.code === "40P01" || pgError.code === "40001") {
      res.status(409).json({
        error: {
          code: "conflict",
          message: "تغيرت البيانات بالتزامن، أعد المحاولة",
        },
      });
      return;
    }
    if (pgError.type === "entity.parse.failed") {
      res
        .status(400)
        .json({ error: { code: "invalid_json", message: "JSON غير صالح" } });
      return;
    }
    if (pgError.type === "entity.too.large") {
      res
        .status(413)
        .json({ error: { code: "body_too_large", message: "حجم الطلب كبير" } });
      return;
    }
    console.error(
      "API operation failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    res
      .status(500)
      .json({ error: { code: "internal", message: "تعذر إتمام الطلب" } });
  };
  app.use(errors);
  let closed = false;
  return {
    app,
    pool,
    config,
    close: async () => {
      if (!closed) {
        closed = true;
        await pool.end();
      }
    },
  };
}

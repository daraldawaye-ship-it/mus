export const DEFAULT_DATABASE_URL =
  "postgresql:///tijara?host=%2Fworkspace%2F.tools%2Fpostgresql%2Fsocket&port=55432&user=agent";
export interface AppOptions {
  databaseUrl?: string;
  schema?: string;
  appOrigin?: string;
  production?: boolean;
  serveStatic?: boolean;
}
export function configuration(options: AppOptions = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const suppliedDatabaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (production && !suppliedDatabaseUrl?.trim())
    throw new Error("DATABASE_URL must be explicitly configured in production");
  const suppliedOrigin =
    options.appOrigin ??
    process.env.APP_ORIGIN ??
    (production ? process.env.RENDER_EXTERNAL_URL : undefined);
  if (production && !suppliedOrigin?.trim())
    throw new Error("APP_ORIGIN must be explicitly configured in production");
  const originValue = suppliedOrigin?.trim() ?? "http://localhost:3000";
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("APP_ORIGIN must be an HTTP origin");
  }
  if (
    !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(originValue) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("APP_ORIGIN must be an HTTP origin");
  if (production && origin.protocol !== "https:")
    throw new Error("Production APP_ORIGIN must use HTTPS");
  return {
    databaseUrl: suppliedDatabaseUrl ?? DEFAULT_DATABASE_URL,
    schema: options.schema ?? process.env.DATABASE_SCHEMA ?? "public",
    appOrigin: origin.origin,
    production,
    serveStatic: options.serveStatic ?? production,
  };
}

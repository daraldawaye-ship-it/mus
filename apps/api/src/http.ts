import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Pool } from "pg";
import type { z } from "zod";
import type { User } from "../../../packages/contracts/src/index.ts";
import { MAX_ID } from "../../../packages/contracts/src/index.ts";
import { userDTO } from "./repositories/models.ts";
import { tokenHash } from "./services/auth.ts";
import { HttpError } from "./errors.ts";

export interface RequestAuth {
  user: User;
  tokenHash: string;
  csrf: string;
  visitorOnly?: boolean;
}
declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
    }
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
export function id(value: string | string[] | undefined): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > MAX_ID
  )
    throw new HttpError(400, "invalid_id", "معرّف غير صالح");
  return Number(value);
}
export function actor(req: Request): User {
  if (!req.auth)
    throw new HttpError(401, "unauthenticated", "يرجى تسجيل الدخول");
  return req.auth.user;
}
export const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
export function loadSession(pool: Pool): RequestHandler {
  return (req, res, next: NextFunction) => {
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("tijara_session="));
    const token = cookie?.slice("tijara_session=".length);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      next();
      return;
    }
    pool
      .query(
        "SELECT u.*,s.token_hash,s.csrf,s.visitor_only FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.archived",
        [tokenHash(token)],
      )
      .then((result) => {
        if (result.rows[0] && !(result.rows[0].visitor_only &&
            req.originalUrl.startsWith("/oauth/")))
          req.auth = {
            user: userDTO(result.rows[0]),
            tokenHash: result.rows[0].token_hash,
            csrf: result.rows[0].csrf,
            visitorOnly: Boolean(result.rows[0].visitor_only),
          };
        next();
      })
      .catch(next);
  };
}
/** Phone-first visitors are authenticated only to contribute to the public
 * medicine market, even if their account acquires company permissions later.
 * They must complete an independently authenticated login to leave this scope. */
export const visitorOnlyGuard: RequestHandler = (req, _res, next) => {
  if (!req.auth?.visitorOnly) return next();
  const path=req.path;
  const authRoutes = new Set([
    "/auth/session", "/auth/logout", "/auth/login",
    "/auth/register", "/auth/login-link/redeem", "/auth/visitor/enter",
  ]);
  if (authRoutes.has(path) || /^\/medicine-market(?:\/|$)/.test(path) ||
      path === "/page-catalog/visit" ||
      (path === "/appearance" &&
        (req.method === "GET" ? (!req.query.scope || req.query.scope==="public")
          : req.body?.scope === "public"))) {
    next();
    return;
  }
  next(new HttpError(403,"visitor_market_only",
    "الدخول المبسط مخصص للسوق الرئيسي فقط. للدخول إلى الشركات استخدم حسابك المحمي"));
};

export function mutationSecurity(origin: string): RequestHandler {
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    if (req.headers.origin !== origin) {
      next(new HttpError(403, "csrf", "مصدر الطلب غير صالح"));
      return;
    }
    // Password login replaces an old employee cookie after a device-local
    // offline switch. It still requires the exact trusted Origin and JSON,
    // and verifies the new password; all other mutations retain CSRF.
    if (req.auth && req.path !== "/auth/login" &&
        req.path !== "/auth/login-link/redeem" &&
        req.path !== "/auth/visitor/enter" &&
        req.headers["x-csrf-token"] !== req.auth.csrf) {
      next(new HttpError(403, "csrf", "رمز حماية الطلب غير صالح"));
      return;
    }
    if (!req.is("application/json")) {
      next(new HttpError(415, "content_type", "الطلب يتطلب JSON"));
      return;
    }
    next();
  };
}
export function setSessionCookie(
  res: Response,
  token: string,
  secure: boolean,
): void {
  res.cookie("tijara_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie("tijara_session", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
  });
}

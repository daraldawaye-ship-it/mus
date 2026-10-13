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
        "SELECT u.*,s.token_hash,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.archived",
        [tokenHash(token)],
      )
      .then((result) => {
        if (result.rows[0])
          req.auth = {
            user: userDTO(result.rows[0]),
            tokenHash: result.rows[0].token_hash,
            csrf: result.rows[0].csrf,
          };
        next();
      })
      .catch(next);
  };
}
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
    if (req.auth && req.headers["x-csrf-token"] !== req.auth.csrf) {
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

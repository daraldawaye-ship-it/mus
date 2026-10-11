import { Router } from "express";
import type { Pool } from "pg";
import {
  registerSchema,
  loginSchema,
  profileSchema,
  passwordChangeSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import {
  actor,
  handler,
  parse,
  setSessionCookie,
  clearSessionCookie,
} from "./http.ts";
import { audit } from "./services/audit.ts";
import {
  createSession,
  passwordHash,
  passwordMatches,
  authLimiter,
} from "./services/auth.ts";
import { userDTO } from "./repositories/models.ts";
import { HttpError } from "./errors.ts";
import { currentActor } from "./policies/access.ts";

export function authRoutes(pool: Pool, secure: boolean): Router {
  const router = Router();
  const limitAuth = authLimiter();
  router.get(
    "/auth/session",
    handler(async (req, res) =>
      res.json({ user: req.auth?.user ?? null, csrf: req.auth?.csrf ?? null }),
    ),
  );
  router.post(
    "/auth/register",
    handler(async (req, res) => {
      limitAuth(`register:${req.ip}`, 100);
      const input = parse(registerSchema, req.body),
        hash = await passwordHash(input.password);
      const result = await transaction(pool, async (client) => {
        const inserted = await client.query(
          "INSERT INTO users(name,display_name,email,phone,image,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            input.name,
            input.displayName,
            input.email,
            input.phone,
            input.image,
            hash,
          ],
        );
        const user = userDTO(inserted.rows[0]);
        await audit(client, user, "user.register", "user", user.id, null, user);
        if (req.auth)
          await client.query("DELETE FROM sessions WHERE token_hash=$1", [
            req.auth.tokenHash,
          ]);
        return { user, ...(await createSession(client, user.id)) };
      });
      setSessionCookie(res, result.token, secure);
      res.status(201).json({ user: result.user, csrf: result.csrf });
    }),
  );
  router.post(
    "/auth/login",
    handler(async (req, res) => {
      limitAuth(`login:${req.ip}`);
      const input = parse(loginSchema, req.body);
      const found = await pool.query("SELECT * FROM users WHERE email=$1", [
        input.email,
      ]);
      const row = found.rows[0];
      // Unknown accounts perform the same asynchronous derivation to reduce enumeration timing.
      const matches = await passwordMatches(
        input.password,
        row?.password_hash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`,
      );
      if (!row || row.archived || !matches)
        throw new HttpError(
          401,
          "invalid_login",
          "البريد أو كلمة المرور غير صحيحة",
        );
      const result = await transaction(pool, async (client) => {
        const locked = await client.query(
          "SELECT * FROM users WHERE id=$1 FOR SHARE",
          [row.id],
        );
        if (
          locked.rows[0].archived ||
          locked.rows[0].password_hash !== row.password_hash
        )
          throw new HttpError(
            401,
            "invalid_login",
            "البريد أو كلمة المرور غير صحيحة",
          );
        const user = userDTO(locked.rows[0]);
        await audit(client, user, "auth.login", "user", user.id, null, null);
        if (req.auth)
          await client.query("DELETE FROM sessions WHERE token_hash=$1", [
            req.auth.tokenHash,
          ]);
        return { user, ...(await createSession(client, user.id)) };
      });
      setSessionCookie(res, result.token, secure);
      res.json({ user: result.user, csrf: result.csrf });
    }),
  );
  router.post(
    "/auth/logout",
    handler(async (req, res) => {
      const user = actor(req);
      await transaction(pool, async (client) => {
        await client.query("DELETE FROM sessions WHERE token_hash=$1", [
          req.auth!.tokenHash,
        ]);
        await audit(client, user, "auth.logout", "user", user.id, null, null);
      });
      clearSessionCookie(res, secure);
      res.json({ ok: true });
    }),
  );
  router.patch(
    "/profile",
    handler(async (req, res) => {
      const input = parse(profileSchema, req.body);
      const user = await transaction(pool, async (client) => {
        const before = await currentActor(client, actor(req));
        const updated = await client.query(
          "UPDATE users SET name=$1,display_name=$2,email=$3,phone=$4,image=$5 WHERE id=$6 RETURNING *",
          [
            input.name,
            input.displayName,
            input.email,
            input.phone,
            input.image,
            before.id,
          ],
        );
        const after = userDTO(updated.rows[0]);
        await audit(
          client,
          before,
          "user.profile",
          "user",
          before.id,
          before,
          after,
        );
        return after;
      });
      res.json({ user });
    }),
  );
  router.post(
    "/auth/password",
    handler(async (req, res) => {
      const user = actor(req),
        input = parse(passwordChangeSchema, req.body);
      const result = await pool.query(
        "SELECT password_hash FROM users WHERE id=$1",
        [user.id],
      );
      const previousHash = result.rows[0]?.password_hash;
      if (
        !previousHash ||
        !(await passwordMatches(input.currentPassword, previousHash))
      )
        throw new HttpError(
          400,
          "invalid_password",
          "كلمة المرور الحالية غير صحيحة",
        );
      const hash = await passwordHash(input.newPassword);
      await transaction(pool, async (client) => {
        const current = await currentActor(client, user);
        const updated = await client.query(
          "UPDATE users SET password_hash=$1 WHERE id=$2 AND password_hash=$3 RETURNING id",
          [hash, user.id, previousHash],
        );
        if (!updated.rowCount)
          throw new HttpError(
            409,
            "conflict",
            "تغيرت كلمة المرور، أعد المحاولة",
          );
        await client.query(
          "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
          [user.id, req.auth!.tokenHash],
        );
        await audit(
          client,
          current,
          "auth.password",
          "user",
          user.id,
          null,
          null,
        );
      });
      res.json({ ok: true });
    }),
  );
  return router;
}

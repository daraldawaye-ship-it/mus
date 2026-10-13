import {
  randomBytes,
  scrypt as derive,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
import type { Database } from "../db.ts";
import { transaction } from "../db.ts";
import {
  registerSchema,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import { userDTO } from "../repositories/models.ts";
import { audit } from "./audit.ts";
import { HttpError } from "../errors.ts";
const scrypt = promisify(derive);
export const tokenHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function passwordMatches(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, salt, hex] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !hex || !/^[a-f0-9]{128}$/.test(hex))
    return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hex, "hex"));
}
export async function createSession(db: Database, userId: number) {
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM sessions WHERE expires_at <= now()");
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
    [tokenHash(token), userId, csrf],
  );
  return { token, csrf };
}
export async function provisionOwner(
  pool: Pool,
  input: {
    name: string;
    displayName: string;
    email: string;
    password: string;
    phone?: string;
  },
): Promise<User> {
  const normalized = registerSchema.parse({
    ...input,
    phone: input.phone ?? "",
    image: "",
  });
  const hash = await passwordHash(normalized.password);
  return transaction(pool, async (client) => {
    const inserted = await client.query(
      "INSERT INTO users(name,display_name,email,phone,image,password_hash,kind,owner) VALUES($1,$2,$3,$4,'',$5,'admin',true) RETURNING *",
      [
        normalized.name,
        normalized.displayName,
        normalized.email,
        normalized.phone,
        hash,
      ],
    );
    const user = userDTO(inserted.rows[0]);
    await audit(client, null, "owner.create", "user", user.id, null, user);
    return user;
  });
}
export function authLimiter(): (key: string, maximum?: number) => void {
  const attempts = new Map<string, { count: number; reset: number }>();
  return (key: string, maximum = 20): void => {
    const now = Date.now();
    const entry = attempts.get(key);
    if (entry && entry.reset > now) {
      entry.count++;
      if (entry.count > maximum)
        throw new HttpError(
          429,
          "rate_limited",
          "محاولات كثيرة، أعد المحاولة لاحقًا",
        );
    } else {
      if (attempts.size > 10000) {
        for (const [key, value] of attempts)
          if (value.reset < now) attempts.delete(key);
        if (attempts.size > 10000) attempts.clear();
      }
      attempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    }
  };
}

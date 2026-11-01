import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";

export const marketPages = ["public.medicine-market", "public.medicine-market-review", "public.medicine-market-contributions", "public.medicine-market-points"] as const;
const identity = z.object({
  id: z.number().int().positive(), displayName: z.string().max(300),
  kind: z.enum(["admin", "supervisor", "member"]), owner: z.boolean(),
  archived: z.boolean(), suspended: z.boolean(), editor: z.boolean(), monitor: z.boolean(),
}).strict();
export const contextSchema = z.object({
  user: identity.nullable(), disabledPages: z.array(z.enum(marketPages)).max(4),
  issuedAt: z.number().int(), nonce: z.string().uuid(),
}).strict();
export type MarketContext = z.infer<typeof contextSchema>;
export function marketIdentity(user: User | null): MarketContext["user"] {
  if (!user) return null;
  const { id, displayName, kind, owner, archived, suspended, editor, monitor } = user;
  return { id, displayName, kind, owner, archived, suspended, editor, monitor };
}
export function asUser(user: NonNullable<MarketContext["user"]>): User {
  return { ...user, name: user.displayName, email: "", phone: "", image: "", createdAt: "" };
}
export function requireMarketSecret(secret: string): void {
  if (Buffer.byteLength(secret) < 32) throw new Error("MARKET_SERVICE_SECRET must contain at least 32 bytes");
}
function signature(secret: string, method: string, path: string, context: string, body: string) {
  return createHmac("sha256", secret).update(JSON.stringify([method, path, context, body])).digest("hex");
}
export function signMarketRequest(secret: string, method: string, path: string, user: User | null, disabledPages: MarketContext["disabledPages"], body: string) {
  const context = Buffer.from(JSON.stringify({ user: marketIdentity(user), disabledPages, issuedAt: Date.now(), nonce: randomUUID() })).toString("base64url");
  return { "x-market-context": context, "x-market-signature": signature(secret, method, path, context, body) };
}
export function marketVerifier(secret: string) {
  requireMarketSecret(secret);
  const used = new Map<string, number>();
  return (method: string, path: string, context: string, supplied: string, body: string): MarketContext => {
    const reject = () => { throw new HttpError(401, "market_auth", "طلب السوق غير معتمد"); };
    if (context.length > 8192 || !/^[a-f0-9]{64}$/.test(supplied)) return reject();
    const expected = signature(secret, method, path, context, body);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) return reject();
    let parsed: MarketContext;
    try { parsed = contextSchema.parse(JSON.parse(Buffer.from(context, "base64url").toString("utf8"))); } catch { return reject(); }
    const now = Date.now();
    if (Math.abs(now - parsed.issuedAt) > 15000) return reject();
    for (const [nonce, expires] of used) if (expires < now) used.delete(nonce);
    if (used.has(parsed.nonce)) return reject();
    if (used.size >= 10000) throw new HttpError(503, "market_busy", "السوق مشغول مؤقتًا");
    used.set(parsed.nonce, now + 30000);
    return parsed;
  };
}

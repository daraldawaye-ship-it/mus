import { createHash } from "node:crypto";
import type { Request, Response } from "express";

/** Run only AFTER the route has checked the current viewer and page/card access.
 * The validator covers the complete authorized payload, including counters,
 * relations and user-specific fields. No shared/public response cache is used. */
export function marketNotModified(req: Request, res: Response, bytes: string | Buffer): boolean {
  const tag = `"${createHash("sha256").update(bytes).digest("base64url")}"`;
  res.set("ETag", tag).vary("Cookie");
  const validators = req.get("if-none-match")?.split(",").map(value => value.trim().replace(/^W\//, ""));
  if ((req.method === "GET" || req.method === "HEAD") && validators?.some(value => value === tag || value === "*")) {
    res.status(304).end();
    return true;
  }
  return false;
}

export function sendMarketRead(req: Request, res: Response, value: unknown): void {
  const bytes = JSON.stringify(value) ?? "null";
  res.set("Cache-Control", "private, no-cache");
  if (!marketNotModified(req, res, bytes)) res.type("application/json").send(bytes);
}

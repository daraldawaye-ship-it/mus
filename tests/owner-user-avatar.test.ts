import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { userPatchSchema } from "../packages/contracts/src/index.ts";
import { mediaRoutes } from "../apps/api/src/routes-media.ts";
import { HttpError } from "../apps/api/src/errors.ts";

const imageId = "a1234567-1234-4734-9734-123456789abc";
const fullUrl = `/api/media/${imageId}/full`;

test("owner avatar patch accepts only an internal full media URL or explicit removal", () => {
  assert.equal(userPatchSchema.parse({ image: fullUrl }).image, fullUrl);
  assert.equal(userPatchSchema.parse({ image: "" }).image, "");
  assert.equal(userPatchSchema.parse({ name: "User" }).image, undefined);
  for (const image of [
    "https://example.test/image.png", `//example.test${fullUrl}`,
    fullUrl.replace("/full", "/thumbnail"), fullUrl + "?download=1", "/api/media/invalid/full",
  ]) assert.equal(userPatchSchema.safeParse({ image }).success, false, image);
});

async function readAvatar({
  viewerId, owner, current, size,
}: {viewerId: number; owner: boolean; current: boolean; size: "thumbnail" | "full"}) {
  const headers = new Map<string, string>();
  const original = Buffer.from("full avatar");
  const thumbnail = Buffer.from("thumbnail");
  const avatarUserId = 2;
  const commands: string[] = [];
  const client = {
    query: async (sql: string, parameters?: unknown[]) => {
      commands.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT * FROM users WHERE id=$1")) {
        assert.deepEqual(parameters, [viewerId]);
        return { rows: [{ id: viewerId, owner, archived: false, kind: "admin", created_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("FROM media_assets WHERE id=$1")) {
        assert.deepEqual(parameters, [imageId]);
        return { rows: [{
          purpose: "avatar", company_id: null, uploaded_by: avatarUserId,
          original_mime: "image/png", thumbnail_mime: "image/webp",
          original_bytes: original, thumbnail_bytes: thumbnail,
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 FROM users WHERE id=$1 AND image=$2")) {
        assert.deepEqual(parameters, [avatarUserId, fullUrl]);
        return { rows: current ? [{}] : [], rowCount: current ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const router = mediaRoutes({ connect: async () => client } as unknown as Pool);
  const route = router.stack.find(layer => layer.route?.path === "/media/:mediaId/:size");
  assert.ok(route);
  const handler = route.route.stack[0].handle as RequestHandler;
  const req = { auth: { user: { id: viewerId } }, params: { mediaId: imageId, size } } as unknown as Request;
  const result = await new Promise<Buffer | Error>((resolve) => {
    const res = {
      setHeader(name: string, value: string) { headers.set(name, value); },
      type(name: string) { headers.set("Content-Type", name); },
      send(bytes: Buffer) { resolve(bytes); },
    } as unknown as Response;
    handler(req, res, (error) => resolve(error instanceof Error ? error : new Error(String(error))));
  });
  return { result, headers, commands, original, thumbnail };
}

test("only the owner can read another user's current avatar thumbnail; no full-image permission expansion", async () => {
  const allowed = await readAvatar({ viewerId: 1, owner: true, current: true, size: "thumbnail" });
  assert.deepEqual(allowed.result, allowed.thumbnail);
  assert.equal(allowed.headers.get("Cache-Control"), "private, no-store");
  assert.equal(allowed.headers.get("Content-Type"), "image/webp");
  for (const request of [
    {viewerId: 1, owner: true, current: false, size: "thumbnail"},
    {viewerId: 1, owner: true, current: true, size: "full"},
    {viewerId: 3, owner: false, current: true, size: "thumbnail"},
  ] as const) {
    const {result, headers, commands} = await readAvatar(request);
    assert.ok(result instanceof HttpError);
    assert.equal(result.status, 404);
    assert.ok(commands.includes("ROLLBACK"));
    assert.ok(!commands.some(sql => /^(UPDATE |DELETE FROM |INSERT INTO )/.test(sql)));
    assert.equal(headers.has("Content-Type"), false);
  }
  const own = await readAvatar({ viewerId: 2, owner: false, current: true, size: "full" });
  assert.deepEqual(own.result, own.original);
});

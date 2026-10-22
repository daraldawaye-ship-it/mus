import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { previewAccessGuard } from "../apps/api/src/preview-access.ts";

const password = "correct-horse-preview-2026!";
const authorization = `Basic ${Buffer.from(`preview:${password}`).toString("base64")}`;

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = createServer(
    previewAccessGuard(password)((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("private preview fails closed without a strong password", () => {
  for (const invalid of [undefined, "", "short", "\n".repeat(20), " ".repeat(20), "x".repeat(257)]) {
    assert.throws(() => previewAccessGuard(invalid), /PREVIEW_ACCESS_PASSWORD/);
  }
});

test("private preview blocks every non-health route without correct Basic credentials", async () => {
  await withServer(async (base) => {
    for (const path of ["/", "/api/me", "/setup-owner", "/assets/app.js", "/api/health/extra"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Basic /);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    for (const header of ["Bearer token", "Basic invalid?", "Basic " + Buffer.from("preview:wrong-password").toString("base64")]) {
      const response = await fetch(`${base}/api/me`, { headers: { authorization: header } });
      assert.equal(response.status, 401, header);
    }
  });
});

test("private preview accepts correct credentials, leaving the readiness endpoint open", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/api/health?check=1`);
    assert.equal(health.status, 200);
    const healthResult = await health.json();
    assert.equal(healthResult.ok, true);
    const healthPost = await fetch(`${base}/api/health`, { method: "POST" });
    assert.equal(healthPost.status, 401);
    for (const path of ["/", "/api/me", "/assets/app.js"]) {
      const response = await fetch(`${base}${path}`, { headers: { authorization } });
      assert.equal(response.status, 200, path);
    }
  });
});

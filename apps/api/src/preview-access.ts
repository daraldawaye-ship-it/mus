import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestListener } from "node:http";

const PREVIEW_USERNAME = "preview";
const HEALTH_PATH = "/api/health";

/** Protects the preview at the HTTP entry point, before Express or static files. */
export function previewAccessGuard(
  password: string | undefined,
): (downstream: RequestListener) => RequestListener {
  if (
    !password ||
    password.length < 16 ||
    password.length > 256 ||
    /[\r\n]/.test(password) ||
    !password.trim()
  ) {
    throw new Error(
      "PREVIEW_ACCESS_PASSWORD must be set to a strong 16-256 character secret before starting the private preview",
    );
  }

  const expectedDigest = createHash("sha256")
    .update(`${PREVIEW_USERNAME}:${password}`, "utf8")
    .digest();

  return (downstream) => (req, res) => {
    // The platform and Docker must be able to check readiness without a login.
    // This endpoint returns only {ok:true}; all other paths require credentials.
    if (req.method === "GET" && req.url?.split("?", 1)[0] === HEALTH_PATH) {
      downstream(req, res);
      return;
    }

    const authorization = req.headers.authorization;
    const match =
      typeof authorization === "string" && authorization.length <= 1024
        ? /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
        : null;
    if (match) {
      const credentials = Buffer.from(match[1], "base64");
      const actualDigest = createHash("sha256").update(credentials).digest();
      if (timingSafeEqual(actualDigest, expectedDigest)) {
        downstream(req, res);
        return;
      }
    }

    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Alraesy private preview", charset="UTF-8"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    res.end("Private preview: sign in to continue.");
  };
}

// Native OAuth clients receive the code on their own loopback listener. PKCE
// and exact registered redirect matching still bind the code to that client.
const nativeCallback = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback(?:\/[A-Za-z0-9_-]{1,128})?$/;

export function oauthRedirectAllowed(raw: string, production: boolean): boolean {
  if (raw !== raw.trim()) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (!production && url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)) return true;

    // Match the original text, not URL-normalized hosts or paths: shorthand IPs,
    // encoded paths, dot segments, queries and non-loopback hosts are excluded.
    const local = nativeCallback.exec(raw);
    if (local && Number(local[1]) <= 65535) return true;

    return url.protocol === "https:" &&
      ["chatgpt.com", "chat.openai.com", "platform.openai.com"].includes(url.hostname) &&
      (url.pathname.startsWith("/connector/") || url.pathname === "/connector_platform_oauth_redirect");
  } catch {
    return false;
  }
}

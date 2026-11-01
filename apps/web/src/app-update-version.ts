/** Compare only content-hashed entry files, never database data or lazy chunks. */
export function appShellBuildFingerprint(html: string): string | null {
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*>/gi)]
    .map(([tag]) => /(?:^|\s)(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1] ?? "")
    .map(url => url.split(/[?#]/)[0])
    .filter(url => /^\/assets\/[a-zA-Z0-9/_-]+\.(?:js|css)$/.test(url));
  return assets.length ? [...new Set(assets)].sort().join("|") : null;
}

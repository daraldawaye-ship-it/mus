import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import type { Pool } from "pg";
import sharp from "sharp";
import type { Database } from "../db.ts";
import { HttpError } from "../errors.ts";

// This module is invoked only against the isolated market database.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 16 });
const MAX_SOURCE = 12 * 1024 * 1024;
const LOCAL_IMAGE = /^\/api\/medicine-market\/images\/([a-f0-9-]{36})$/;
// Only two persistent files: bounded main WebP and icon. The preview name
// remains an HTTP/schema compatibility alias, never a third local file.
export type ImageVariant = "icon" | "preview" | "main";
export type ImageVariants = {
  icon: Buffer; preview: Buffer;
  iconWidth: number; iconHeight: number;
  previewWidth: number; previewHeight: number; sourceBytes: number;
};
export const imageSourceKey = (source: string) => createHash("sha256").update(source).digest("hex");
let transformations = 0;

/** GIF is decoded as one still frame; metadata and the raw input are not stored. */
export async function buildMarketImageVariants(bytes: Buffer): Promise<ImageVariants> {
  if (!bytes.length || bytes.length > MAX_SOURCE)
    throw new HttpError(400, "image_size", "حجم الصورة غير مدعوم");
  if (transformations >= 2)
    throw new HttpError(429, "image_busy", "تجهيز الصور مشغول؛ أعد المحاولة");
  transformations++;
  try {
    const options = { limitInputPixels: 30_000_000, animated: false, pages: 1 };
    const meta = await sharp(bytes, options).metadata();
    if (!["jpeg", "png", "webp", "gif", "avif", "heif"].includes(meta.format ?? ""))
      throw new HttpError(400, "image_format", "صيغة الصورة غير مدعومة");
    const resize = async (size: number, maximum: number) => {
      for (const scale of [1, 0.8, 0.6]) {
        for (const quality of [82, 70, 56, 42, 28]) {
          const side = Math.max(1, Math.floor(size * scale));
          const output = await sharp(bytes, options).rotate()
            .resize(side, side, { fit: "inside", withoutEnlargement: true })
            .webp({ quality, effort: 3 }).timeout({ seconds: 2 })
            .toBuffer({ resolveWithObject: true });
          if (output.data.length <= maximum) return output;
        }
      }
      throw new HttpError(400, "image_size", "تعذر تجهيز نسخة خفيفة للصورة");
    };
    // Do not recompress or enlarge old images that already meet the policy.
    const reusable = meta.format === "webp" && (meta.pages ?? 1) === 1 &&
      !!meta.width && !!meta.height && meta.width <= 1200 && meta.height <= 1200 &&
      bytes.length <= 200 * 1024 && !meta.exif && !meta.xmp && !meta.icc && !meta.orientation;
    const main = reusable ? { data: bytes, info: { width: meta.width!, height: meta.height! } }
      : await resize(1200, 200 * 1024);
    const icon = await resize(64, 16 * 1024);
    return { icon: icon.data, preview: main.data,
      iconWidth: icon.info.width, iconHeight: icon.info.height,
      previewWidth: main.info.width, previewHeight: main.info.height,
      sourceBytes: main.data.length };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "image_decode", "تعذر قراءة الصورة أو أبعادها كبيرة جدًا");
  } finally { transformations--; }
}

/** Local main bytes live once in uploads; external cached main bytes live once here. */
export async function storeMarketImageVariants(db: Database, source: string, value: ImageVariants) {
  const localId = LOCAL_IMAGE.exec(source)?.[1] ?? null;
  if (localId) {
    // Preserve identity, moderation, card revision and ordering. Replace oversized
    // historical bytes only after a valid, bounded WebP has been generated.
    await db.query(`UPDATE market_image_uploads SET image_bytes=$2,byte_size=$3,width=$4,height=$5
      WHERE id=$1 AND (image_bytes IS DISTINCT FROM $2 OR byte_size IS DISTINCT FROM $3
        OR width IS DISTINCT FROM $4 OR height IS DISTINCT FROM $5)`,
      [localId,value.preview,value.preview.length,value.previewWidth,value.previewHeight]);
  }
  await db.query(`INSERT INTO market_image_variants
    (source_key,source_url,image_id,status,icon_bytes,preview_bytes,icon_width,icon_height,
     preview_width,preview_height,source_bytes,error_code,storage_version)
    VALUES($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9,$10,'',2)
    ON CONFLICT(source_key) DO UPDATE SET status='ready',image_id=EXCLUDED.image_id,
      icon_bytes=EXCLUDED.icon_bytes,preview_bytes=EXCLUDED.preview_bytes,
      icon_width=EXCLUDED.icon_width,icon_height=EXCLUDED.icon_height,
      preview_width=EXCLUDED.preview_width,preview_height=EXCLUDED.preview_height,
      source_bytes=EXCLUDED.source_bytes,error_code='',storage_version=2,updated_at=now()`,
    [imageSourceKey(source), source, localId, value.icon, localId ? null : value.preview,
      value.iconWidth, value.iconHeight, localId ? null : value.previewWidth,
      localId ? null : value.previewHeight, value.sourceBytes]);
}

export async function readMarketImageVariant(db: Database, source: string, variant: ImageVariant): Promise<Buffer | null> {
  // The caller checks card/image visibility and source-card binding first.
  const column = variant === "icon" ? "v.icon_bytes"
    : "CASE WHEN v.image_id IS NOT NULL THEN i.image_bytes ELSE v.preview_bytes END";
  const result = await db.query(`SELECT ${column} AS bytes FROM market_image_variants v
    LEFT JOIN market_image_uploads i ON i.id=v.image_id
    WHERE v.source_key=$1 AND v.status='ready'`, [imageSourceKey(source)]);
  return result.rows[0]?.bytes ?? null;
}

/** IPv4-only pinned DNS: never fetch localhost, private networks or metadata services. */
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export function validateExternalImageUrl(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("image_source"); }
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || url.hostname.includes(":") ||
      url.hostname.endsWith(".") || url.hostname === "localhost" ||
      !url.hostname.includes(".") || source.length > 2000)
    throw new Error("image_source");
  if (isIP(url.hostname) && !isPublicImageAddress(url.hostname)) throw new Error("image_source");
  return url;
}
async function downloadPublicImage(source: string): Promise<Buffer> {
  let current = source;
  for (let redirect = 0; redirect < 4; redirect++) {
    const url = validateExternalImageUrl(current);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("image_dns")), 3000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!addresses.length || addresses.some(entry => !isPublicImageAddress(entry.address)))
      throw new Error("image_source");
    const address = addresses[0].address;
    const response = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
      const req = request(url, { method: "GET", family: 4,
        // Keep the original hostname for TLS/SNI, but connect only to the checked IP.
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        headers: { Accept: "image/webp,image/png,image/jpeg,image/gif,image/avif", "User-Agent": "Alraesy-Market-Image-Variants/1.0" },
      }, res => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const location = new URL(res.headers.location, url).href;
          res.resume(); resolve({ location }); return;
        }
        if (status !== 200 || !/^image\/(?:webp|png|jpeg|gif|avif)(?:;|$)/i.test(res.headers["content-type"] ?? "") ||
            Number(res.headers["content-length"] ?? 0) > MAX_SOURCE) {
          res.resume(); reject(new Error("image_http")); return;
        }
        const parts: Buffer[] = []; let size = 0;
        res.on("data", (part: Buffer) => {
          size += part.length;
          if (size > MAX_SOURCE) { req.destroy(new Error("image_size")); return; }
          parts.push(part);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ bytes: Buffer.concat(parts) }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("image_timeout")), 6000);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject); req.end();
    });
    if (response.bytes) return response.bytes;
    if (!response.location) throw new Error("image_http");
    current = response.location;
  }
  throw new Error("image_redirects");
}

// Include historical and pending local uploads too, not only current card photos.
const sourcesSql = `SELECT min(card_id)::integer AS card_id,source_url FROM (
  SELECT c.id AS card_id,
    COALESCE(NULLIF(c.data->>'image',''),NULLIF(c.data->>'imageUrl','')) AS source_url
    FROM medicine_market_cards c WHERE c.kind<>'composition'
  UNION ALL
  SELECT i.card_id,'/api/medicine-market/images/'||i.id::text
    FROM market_image_uploads i JOIN medicine_market_cards c ON c.id=i.card_id
    WHERE c.kind<>'composition'
) all_sources WHERE source_url IS NOT NULL GROUP BY source_url`;
type BackfillState = { running: boolean; processed: number; ready: number; failed: number; lastError: string | null };
const jobs = new WeakMap<Pool, BackfillState>();

export async function marketImageBackfillStatus(pool: Pool) {
  const counts = (await pool.query(`WITH sources AS (${sourcesSql})
    SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE v.status='ready' AND v.storage_version=2)::integer AS ready,
      count(*) FILTER(WHERE v.status='error')::integer AS failed,
      count(*) FILTER(WHERE v.source_key IS NULL OR (v.status='ready' AND v.storage_version<2))::integer AS pending,
      COALESCE(sum(octet_length(v.icon_bytes)),0)::text AS "iconBytes",
      COALESCE(sum(octet_length(v.preview_bytes)) FILTER(WHERE v.image_id IS NOT NULL),0)::text AS "previewBytes",
      COALESCE(sum(CASE WHEN v.image_id IS NOT NULL THEN octet_length(i.image_bytes) ELSE octet_length(v.preview_bytes) END),0)::text AS "mainBytes",
      COALESCE(sum(v.source_bytes),0)::text AS "sourceBytes"
    FROM sources s LEFT JOIN market_image_variants v ON v.source_url=s.source_url
      LEFT JOIN market_image_uploads i ON i.id=v.image_id`)).rows[0];
  const failures = (await pool.query(`WITH sources AS (${sourcesSql})
    SELECT s.card_id AS "cardId",c.name,v.error_code AS "reason"
    FROM sources s JOIN market_image_variants v ON v.source_url=s.source_url AND v.status='error'
    JOIN medicine_market_cards c ON c.id=s.card_id ORDER BY s.card_id LIMIT 30`)).rows;
  return { ...counts, running: jobs.get(pool)?.running ?? false,
    run: jobs.get(pool) ?? null, failures, iconMaxSide: 64, iconMaxBytes: 16384,
    mainMaxSide: 1200, mainMaxBytes: 204800, storedCopies: 2, policyVersion: 2 };
}

/** One sequential, owner-triggered pass; saved successes survive process restarts. */
export function startMarketImageBackfill(pool: Pool, retryFailed = false) {
  if (jobs.get(pool)?.running) return false;
  const state: BackfillState = { running: true, processed: 0, ready: 0, failed: 0, lastError: null };
  jobs.set(pool, state);
  void (async () => {
    const db = await pool.connect(); let locked = false;
    try {
      locked = Boolean((await db.query("SELECT pg_try_advisory_lock(hashtext('market-image-variants-v1')) AS locked")).rows[0].locked);
      if (!locked) return;
      let after = "";
      for (;;) {
        const batch = (await db.query(`WITH sources AS (${sourcesSql})
          SELECT s.* FROM sources s LEFT JOIN market_image_variants v ON v.source_url=s.source_url
          WHERE s.source_url>$1 AND (v.source_key IS NULL OR (v.status='ready' AND v.storage_version<2) OR ($2 AND v.status='error'))
          ORDER BY s.source_url LIMIT 20`, [after, retryFailed])).rows;
        if (!batch.length) break;
        for (const entry of batch) {
          after = String(entry.source_url); const source = after;
          try {
            const localId = LOCAL_IMAGE.exec(source)?.[1];
            const bytes: Buffer | undefined = localId
              ? (await db.query("SELECT image_bytes FROM market_image_uploads WHERE id=$1", [localId])).rows[0]?.image_bytes
              : await downloadPublicImage(source);
            if (!bytes) throw new Error("image_missing");
            const variants = await buildMarketImageVariants(bytes);
            await storeMarketImageVariants(db, source, variants);
            state.ready++;
          } catch (cause) {
            const message = cause instanceof HttpError ? cause.code : cause instanceof Error ? cause.message : "image_error";
            const reason = /^image_[a-z_]+$/.test(message) ? message : "image_error";
            // Never store raw exception strings, remote bodies or a deleted private image.
            await db.query(`INSERT INTO market_image_variants(source_key,source_url,status,error_code)
              VALUES($1,$2,'error',$3) ON CONFLICT(source_key) DO UPDATE
              SET error_code=EXCLUDED.error_code,updated_at=now() WHERE market_image_variants.status<>'ready'`,
              [imageSourceKey(source), source, reason]);
            state.failed++;
          }
          state.processed++;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    } finally {
      if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('market-image-variants-v1'))").catch(() => undefined);
      db.release();
    }
  })().catch(() => { state.lastError = "image_backfill_interrupted"; })
    .finally(() => { state.running = false; });
  return true;
}

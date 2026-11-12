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
export type ImageVariant = "icon" | "preview";
export type ImageVariants = {
  icon: Buffer; preview: Buffer;
  iconWidth: number; iconHeight: number;
  previewWidth: number; previewHeight: number; sourceBytes: number;
};
export const imageSourceKey = (source: string) => createHash("sha256").update(source).digest("hex");
let transformations = 0;

/** Decode once per size, preserve the complete image and strip metadata. */
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
      for (const quality of [76, 60, 44, 28]) {
        const output = await sharp(bytes, options).rotate()
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .webp({ quality, effort: 3 }).timeout({ seconds: 2 })
          .toBuffer({ resolveWithObject: true });
        if (output.data.length <= maximum) return output;
      }
      throw new HttpError(400, "image_size", "تعذر تجهيز نسخة خفيفة للصورة");
    };
    const icon = await resize(64, 16 * 1024);
    const preview = await resize(240, 64 * 1024);
    return { icon: icon.data, preview: preview.data,
      iconWidth: icon.info.width, iconHeight: icon.info.height,
      previewWidth: preview.info.width, previewHeight: preview.info.height,
      sourceBytes: bytes.length };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "image_decode", "تعذر قراءة الصورة أو أبعادها كبيرة جدًا");
  } finally { transformations--; }
}

/** Foreign key removes every derivative when a private prescription photo is deleted. */
export async function storeMarketImageVariants(db: Database, source: string, value: ImageVariants) {
  const localId = LOCAL_IMAGE.exec(source)?.[1] ?? null;
  await db.query(`INSERT INTO market_image_variants
    (source_key,source_url,image_id,status,icon_bytes,preview_bytes,icon_width,icon_height,
     preview_width,preview_height,source_bytes,error_code)
    VALUES($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9,$10,'')
    ON CONFLICT(source_key) DO UPDATE SET status='ready',image_id=EXCLUDED.image_id,
      icon_bytes=EXCLUDED.icon_bytes,preview_bytes=EXCLUDED.preview_bytes,
      icon_width=EXCLUDED.icon_width,icon_height=EXCLUDED.icon_height,
      preview_width=EXCLUDED.preview_width,preview_height=EXCLUDED.preview_height,
      source_bytes=EXCLUDED.source_bytes,error_code='',updated_at=now()`,
    [imageSourceKey(source), source, localId, value.icon, value.preview,
      value.iconWidth, value.iconHeight, value.previewWidth, value.previewHeight, value.sourceBytes]);
}

export async function readMarketImageVariant(db: Database, source: string, variant: ImageVariant): Promise<Buffer | null> {
  // The caller must check card/image visibility BEFORE reading any derivative.
  const column = variant === "icon" ? "icon_bytes" : "preview_bytes";
  const result = await db.query(`SELECT ${column} AS bytes FROM market_image_variants
    WHERE source_key=$1 AND status='ready'`, [imageSourceKey(source)]);
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
      const req = request(url, { method: "GET", family: 4, autoSelectFamily: false,
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

const sourcesSql = `SELECT min(c.id)::integer AS card_id,
  COALESCE(NULLIF(c.data->>'image',''),NULLIF(c.data->>'imageUrl','')) AS source_url
  FROM medicine_market_cards c WHERE c.kind<>'composition'
    AND COALESCE(NULLIF(c.data->>'image',''),NULLIF(c.data->>'imageUrl','')) IS NOT NULL
  GROUP BY COALESCE(NULLIF(c.data->>'image',''),NULLIF(c.data->>'imageUrl',''))`;
type BackfillState = { running: boolean; processed: number; ready: number; failed: number; lastError: string | null };
const jobs = new WeakMap<Pool, BackfillState>();

export async function marketImageBackfillStatus(pool: Pool) {
  const counts = (await pool.query(`WITH sources AS (${sourcesSql})
    SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE v.status='ready')::integer AS ready,
      count(*) FILTER(WHERE v.status='error')::integer AS failed,
      count(*) FILTER(WHERE v.source_key IS NULL)::integer AS pending,
      COALESCE(sum(octet_length(v.icon_bytes)),0)::text AS "iconBytes",
      COALESCE(sum(octet_length(v.preview_bytes)),0)::text AS "previewBytes",
      COALESCE(sum(v.source_bytes),0)::text AS "sourceBytes"
    FROM sources s LEFT JOIN market_image_variants v ON v.source_url=s.source_url`)).rows[0];
  const failures = (await pool.query(`WITH sources AS (${sourcesSql})
    SELECT s.card_id AS "cardId",c.name,v.error_code AS "reason"
    FROM sources s JOIN market_image_variants v ON v.source_url=s.source_url AND v.status='error'
    JOIN medicine_market_cards c ON c.id=s.card_id ORDER BY s.card_id LIMIT 30`)).rows;
  return { ...counts, running: jobs.get(pool)?.running ?? false,
    run: jobs.get(pool) ?? null, failures, iconMaxSide: 64, previewMaxSide: 240 };
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
      let after = 0;
      for (;;) {
        const batch = (await db.query(`WITH sources AS (${sourcesSql})
          SELECT s.* FROM sources s LEFT JOIN market_image_variants v ON v.source_url=s.source_url
          WHERE s.card_id>$1 AND (v.source_key IS NULL OR ($2 AND v.status='error'))
          ORDER BY s.card_id LIMIT 20`, [after, retryFailed])).rows;
        if (!batch.length) break;
        for (const entry of batch) {
          after = Number(entry.card_id); const source = String(entry.source_url);
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

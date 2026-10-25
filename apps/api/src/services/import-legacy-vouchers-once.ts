import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { Pool } from "pg";

const SOURCE_SYSTEM = "dar-al-dawa-legacy-vouchers-2026-10-26";
const COMPANY_ID = 2;
const EXPECTED_ROWS = 29246;
const COLUMNS = [
  "معرف_حركة_السندات_م", "معرف_الحساب", "رقم_السند", "رقم_الوصل",
  "ملاحظات_السند", "نوع_السند", "مجموع_دائن_ومدين",
  "المنشى_بدون_تعديل_للسندات", "الانشاء_بدون_تعديل_للسندات", "معرف_الصندوق",
] as const;

function unzip(buffer: Buffer, filename: string): Buffer {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("ZIP end of directory missing");
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid ZIP central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== filename) continue;
    if (size > 25_000_000) throw new Error("Uncompressed legacy file is too large");
    if (buffer.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Invalid ZIP local header");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const payload = buffer.subarray(start, start + compressed);
    const output = method === 0 ? Buffer.from(payload)
      : method === 8 ? inflateRawSync(payload, {maxOutputLength: 25_000_000})
      : (() => {throw new Error("Unsupported ZIP compression");})();
    if (output.length !== size) throw new Error("ZIP size mismatch");
    return output;
  }
  throw new Error("ZIP entry missing: " + filename);
}

function xmlDecode(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, s: string) => {
      const n = s[0]?.toLowerCase() === "x" ? parseInt(s.slice(1), 16) : parseInt(s, 10);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, s: string) =>
      ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"})[s] ?? "");
}

type RawRow = {
  source_id: string;
  source_row_number: number;
  source_payload: Record<string, string | null>;
  payload_sha256: string;
  posting_date: string | null;
};

function parseSheet(xml: string): RawRow[] {
  const rows: RawRow[] = [];
  const seen = new Set<string>();
  const rowPattern = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellPattern = /<c\b[^>]*\br="([A-J])(\d+)"[^>]*>([\s\S]*?)<\/c>/g;
  for (const match of xml.matchAll(rowPattern)) {
    const rowNumber = Number(match[1]);
    const fields: Array<string | null> = Array(10).fill(null);
    for (const cell of match[2]!.matchAll(cellPattern)) {
      const index = cell[1]!.charCodeAt(0) - 65;
      const value = cell[3]!.match(/<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/);
      if (value) fields[index] = xmlDecode(value[1]!);
    }
    if (rowNumber === 1) {
      for (let i = 0; i < COLUMNS.length; i++)
        if (fields[i] !== COLUMNS[i]) throw new Error("Voucher XLSX header mismatch");
      continue;
    }
    const sourceId = fields[0]?.trim();
    if (!sourceId) throw new Error("Missing voucher ID in Excel row " + rowNumber);
    if (seen.has(sourceId)) throw new Error("Duplicate voucher ID " + sourceId);
    seen.add(sourceId);
    const raw = Object.fromEntries(COLUMNS.map((col, i) => [col, fields[i]]));
    const serial = Number(fields[8]);
    const date = Number.isFinite(serial) && serial > 0
      ? new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10)
      : null;
    rows.push({
      source_id: sourceId,
      source_row_number: rowNumber,
      source_payload: raw,
      payload_sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      posting_date: date,
    });
  }
  if (rows.length !== EXPECTED_ROWS)
    throw new Error("Unexpected voucher count " + rows.length);
  return rows;
}

// One-time isolated intake. Never creates financial documents or journal entries.
export async function importLegacyVouchersOnce(pool: Pool): Promise<void> {
  const url = process.env.ALRAESY_LEGACY_VOUCHERS_ZIP_URL;
  if (!url) return;
  const old = await pool.query(
    "SELECT count(*)::integer AS count FROM legacy_voucher_raw_import WHERE company_id=$1 AND source_system=$2",
    [COMPANY_ID, SOURCE_SYSTEM],
  );
  if (old.rows[0]?.count === EXPECTED_ROWS) {
    console.info("LEGACY_VOUCHERS_STAGED", {count: EXPECTED_ROWS, existing: true});
    return;
  }
  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname.endsWith(".oaiusercontent.com"))
    throw new Error("Private legacy voucher URL must be the approved signed file host");
  const response = await fetch(url, {redirect:"error",signal:AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error("Voucher archive fetch failed, HTTP " + response.status);
  const zip = Buffer.from(await response.arrayBuffer());
  if (zip.length > 6_000_000) throw new Error("Voucher archive exceeds limit");
  const xlsx = unzip(zip, "حركة_السندات2.xlsx");
  const xml = unzip(xlsx, "xl/worksheets/sheet1.xml").toString("utf8");
  const rows = parseSheet(xml);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('legacy-vouchers-pharmacy-2'))");
    for (let i = 0; i < rows.length; i += 350) {
      await client.query(
        [
          "INSERT INTO legacy_voucher_raw_import",
          "(company_id,source_system,source_id,source_row_number,source_payload,payload_sha256,posting_date)",
          "SELECT $1,$2,v.source_id,v.source_row_number,v.source_payload,v.payload_sha256,v.posting_date::date",
          "FROM jsonb_to_recordset($3::jsonb) AS v",
          "(source_id text,source_row_number integer,source_payload jsonb,payload_sha256 text,posting_date text)",
          "ON CONFLICT (company_id,source_system,source_id) DO NOTHING",
        ].join(" "),
        [COMPANY_ID, SOURCE_SYSTEM, JSON.stringify(rows.slice(i,i+350))],
      );
    }
    const count = await client.query(
      "SELECT count(*)::integer AS count FROM legacy_voucher_raw_import WHERE company_id=$1 AND source_system=$2",
      [COMPANY_ID, SOURCE_SYSTEM],
    );
    if (count.rows[0]?.count !== EXPECTED_ROWS)
      throw new Error("Voucher staging count mismatch: " + count.rows[0]?.count);
    await client.query("COMMIT");
    console.info("LEGACY_VOUCHERS_STAGED", {count: EXPECTED_ROWS, existing:false, companyId: COMPANY_ID});
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

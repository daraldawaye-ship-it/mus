import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { stagingBatchSchema } from "../routes-transaction-import-schemas.ts";

const COMPANY_ID = 2;
const SOURCE = "dar-aldawa-legacy-2026-10";
const OWNER_ID = 1;
const LEGACY_ACCOUNTS_SOURCE = "ac333333.xlsx";
const EXPECTED_INVOICES = 9;
const EXPECTED_LINES = 57;

// The owner's spreadsheet contains exactly nine previously missing purchases.
type CompactLine = [
  movementId: string, legacyItemId: string, quantity: string, unitPrice: string,
  sourceAccountNumber: string, sourceNotes: string
];
type CompactInvoice = [
  sourceId: string, sourceLocalDateTime: string, sourceCreator: string,
  receiptNumber: string, legacySupplierId: string, legacyCashId: string,
  lines: CompactLine[]
];
const invoices = JSON.parse(readFileSync(
  new URL("./data/oct-2026-nine-purchases.json", import.meta.url), "utf8",
)) as CompactInvoice[];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k,v]) => [k, canonical(v)]));
  return value;
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function stableUuid(input: string): string {
  const bytes = createHash("sha256").update(input).digest();
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.subarray(0,16).toString("hex");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),
    hex.slice(16,20),hex.slice(20)].join("-");
}

/**
 * Only stages nine October 2026 purchase invoices from "مش(1).xlsx"
 * if neither staged nor posted already. No accounting, balances, real
 * stock movements, invoice records, or processing jobs are created.
 */
export async function stageNineNewOctoberPurchasesOnce(pool: Pool): Promise<void> {
  if (invoices.length !== EXPECTED_INVOICES ||
      invoices.reduce((n,x) => n+x[6].length,0) !== EXPECTED_LINES ||
      new Set(invoices.map(x => x[0])).size !== EXPECTED_INVOICES)
    throw new Error("Initial purchase intake: source counts or identities changed");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stage-nine-purchases-oct2026'),$1)",
      [COMPANY_ID],
    );
    const owner = await client.query(
      "SELECT 1 FROM users WHERE id=$1 AND owner AND NOT suspended AND NOT archived",
      [OWNER_ID],
    );
    if (owner.rowCount !== 1)
      throw new Error("Initial purchase intake: owner authorization unavailable");

    const oldItems = [...new Set(invoices.flatMap(x => x[6].map(l => l[1])))];
    const items = await client.query<{id:number;legacy_id:string}>(
      "SELECT id,legacy_id FROM items WHERE company_id=$1 AND legacy_id=ANY($2::text[])",
      [COMPANY_ID,oldItems],
    );
    const itemMap = new Map<string,number>();
    for (const row of items.rows) {
      if (itemMap.has(row.legacy_id)) throw new Error("Duplicate legacy item "+row.legacy_id);
      itemMap.set(row.legacy_id,row.id);
    }
    if (itemMap.size !== oldItems.length)
      throw new Error("Unmapped legacy item in initial purchase intake");

    const oldAccounts = [...new Set(invoices.flatMap(x => [x[4],x[5]]))].map(Number);
    const accounts = await client.query<{legacy_id:number;account_id:number}>(
      "SELECT legacy_id,account_id FROM legacy_account_imports WHERE company_id=$1 AND source=$2 AND legacy_id=ANY($3::integer[])",
      [COMPANY_ID,LEGACY_ACCOUNTS_SOURCE,oldAccounts],
    );
    const accountMap = new Map<number,number>();
    for (const row of accounts.rows) {
      if (accountMap.has(row.legacy_id))
        throw new Error("Duplicate legacy account "+row.legacy_id);
      accountMap.set(row.legacy_id,row.account_id);
    }
    if (accountMap.size !== oldAccounts.length)
      throw new Error("Unmapped legacy account in initial purchase intake");

    let added = 0, alreadyPosted = 0, alreadyStaged = 0;
    for (const [sourceId,localDateTime,creator,receipt,legacySupplier,legacyCash,lines] of invoices) {
      if (!/^\d{15}$/.test(sourceId) ||
        !/^2026-10-(?:27|28|29)T\d\d:\d\d:\d\d$/.test(localDateTime))
        throw new Error("Unexpected source identity or date");
      const posted = await client.query(
        "SELECT 1 FROM transaction_source_imports WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2 LIMIT 1",
        [COMPANY_ID,sourceId],
      );
      if (posted.rowCount) { alreadyPosted++; continue; }
      const staged = await client.query(
        "SELECT 1 FROM legacy_import_staging WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2 LIMIT 1",
        [COMPANY_ID,sourceId],
      );
      if (staged.rowCount) { alreadyStaged++; continue; }

      const supplierId = accountMap.get(Number(legacySupplier));
      const cashId = accountMap.get(Number(legacyCash));
      if (!supplierId || !cashId) throw new Error("Missing purchase account mapping");
      const sourceRows = lines.map(([movementId,itemOld,qty,unitPrice,sourceAccountNumber,sourceNotes]) => ({
        "معرف_حركة_الاصناف_م":movementId,
        "رقم_الحساب":sourceAccountNumber,
        "معرف_الحساب":legacySupplier,
        "معرف_الصنف":itemOld,
        "نوع_العمليه":"فاتورة مشتريات",
        "ملاحظات_الخصم":sourceNotes,
        "رقم_السند":sourceId,
        "الانشاء_بدون_تعديل":localDateTime,
        "المنشى_بدون_تعديل":creator,
        "تكلفة_الوحده_المحسوبه":unitPrice,
        "الكمية_المحسوبة_اخيرا":qty,
        "رقم_الوصل":receipt,
        "صندوق_الحساب_معرف":legacyCash,
        "__source_file":"مش(1).xlsx",
      }));
      const document = {
        type:"invoice" as const,
        sourceId,
        sourceDocumentNumber:sourceId,
        sourceCreatedAt:localDateTime+".000+03:00",
        sourceCreators:[creator],
        sourceMovementIds:lines.map(l => l[0]),
        sourceRows,
        payload:{
          idempotencyKey:stableUuid([SOURCE,sourceId,"initial-only"].join(":")),
          kind:"purchase" as const,
          documentDate:localDateTime.slice(0,10),
          currencyId:7,
          branchId:2,
          locationId:2,
          counterpartyAccountId:cashId,
          supplierAccountId:supplierId,
          doctorId:null,
          doctorName:"",
          saleCustomerNumber:"",
          saleCustomerName:"",
          supplierReceiptNumber:receipt,
          description:"حفظ أولي من ملف مش(1).xlsx — رقم فاتورة المصدر "+sourceId,
          discount:"0",
          lines:lines.map(l => ({
            itemId:itemMap.get(l[1]),
            unit:1 as const,quantity:l[2],unitPrice:l[3],
            expiryDate:null,originalLineId:null,
          })),
        },
      };
      const checked = stagingBatchSchema.safeParse({
        idempotencyKey:stableUuid([SOURCE,sourceId,"staging-batch"].join(":")),
        sourceSystem:SOURCE,
        postingDate:document.payload.documentDate,
        documents:[document],
      });
      if (!checked.success)
        throw new Error("Invalid source "+sourceId+": "+
          checked.error.issues.map(x=>x.path.join(".")+": "+x.message).join("; "));
      const verifiedDocument = checked.data.documents[0];
      const inserted = await client.query(
        "INSERT INTO legacy_import_staging "+
        "(company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,created_by) "+
        "VALUES ($1,$2,'invoice',$3,$4::date,$5::jsonb,$6,$7) "+
        "ON CONFLICT DO NOTHING RETURNING source_id",
        [COMPANY_ID,SOURCE,sourceId,document.payload.documentDate,
          JSON.stringify(verifiedDocument),sha256(verifiedDocument),OWNER_ID],
      );
      if (inserted.rowCount !== 1)
        throw new Error("Source staging conflict "+sourceId);
      added++;
    }
    if (added+alreadyPosted+alreadyStaged!==EXPECTED_INVOICES)
      throw new Error("Initial purchase intake count mismatch");
    await client.query("COMMIT");
    console.info("OCT2026_NINE_PURCHASES_INITIAL_STAGING",{
      added,alreadyPosted,alreadyStaged,sourceInvoices:EXPECTED_INVOICES,sourceLines:EXPECTED_LINES,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

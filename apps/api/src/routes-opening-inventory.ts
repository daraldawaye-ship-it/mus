import { Router, type Request } from "express";
import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { actor, handler, id } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { mutateMaster, readMaster, conflict } from "./services/masters.ts";
import {
  applyStock, auditStockOperation, createStockOperation,
  requireInventorySettings,
} from "./services/inventory.ts";
import { postCommerceJournal } from "./services/commerce-ledger.ts";
import { convertedUnits, moneyString, moneyUnits, quantum } from "./services/finance.ts";

const prepareSchema = z.object({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  locationId: z.number().int().positive(),
  equityAccountId: z.number().int().positive(),
  documentDate: z.iso.date(),
  expectedCount: z.number().int().positive().max(20000),
}).strict();
const requestId = z.string().uuid();
const activeWorkers = new Map<string, { stopped: boolean }>();
type Target = { legacyId: string; smallest: string; approximate: boolean };
function fail(message: string): never {
  throw new HttpError(400, "invalid_opening_inventory", message);
}
function zipMember(zip: Buffer, member: string, suffix = false): Buffer {
  let index = 0;
  while (index + 30 <= zip.length && zip.readUInt32LE(index) === 0x04034b50) {
    const method = zip.readUInt16LE(index + 8);
    const size = zip.readUInt32LE(index + 18);
    const nameLength = zip.readUInt16LE(index + 26);
    const extraLength = zip.readUInt16LE(index + 28);
    const name = zip.subarray(index + 30, index + 30 + nameLength).toString("utf8");
    const from = index + 30 + nameLength + extraLength;
    if (from + size > zip.length) fail("ملف ZIP غير مكتمل");
    if ((suffix ? name.endsWith(member) : name === member)) {
      if (method !== 8 && method !== 0) fail("صيغة ضغط الملف غير مدعومة");
      const out = method === 8
        ? inflateRawSync(zip.subarray(from, from + size), { maxOutputLength: 16000000 })
        : zip.subarray(from, from + size);
      if (out.length > 16000000) fail("حجم ورقة الأصناف يتجاوز الحد");
      return out;
    }
    index = from + size;
  }
  fail("لم أجد ورقة الأصناف المطلوبة في الملف المضغوط");
}
function readSource(zip: Buffer): { legacyId: string; quantity: string }[] {
  const workbook = zipMember(zip, ".xlsx", true);
  const sheet = zipMember(workbook, "xl/worksheets/sheet1.xml").toString("utf8");
  const items: { legacyId: string; quantity: string }[] = [];
  const seen = new Set<string>();
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<string, string>();
    for (const cell of row[1].matchAll(/<c r="([A-G])\d+"[^>]*><v>([^<]+)<\/v><\/c>/g))
      cells.set(cell[1], cell[2]);
    const legacyId = cells.get("A"), quantity = cells.get("B");
    if (!legacyId && !quantity) continue;
    if (!legacyId || !quantity || !/^\d+$/.test(legacyId) ||
        !/^\d+(?:\.\d+)?$/.test(quantity))
      fail("أحد صفوف المصدر لا يحتوي معرف صنف أو كمية رقمية سليمة");
    if (seen.has(legacyId)) fail("المعرف مكرر في ملف الأصناف: " + legacyId);
    seen.add(legacyId);
    items.push({ legacyId, quantity });
    if (items.length > 20000) fail("عدد أصناف الملف يتجاوز الحد المسموح");
  }
  if (!items.length) fail("ملف الأصناف فارغ");
  return items;
}
/** Round floating point export noise to the smallest stock unit, not to whole packs. */
function smallest(raw: string, factor: bigint): { value: string; approximate: boolean } {
  const [whole, fraction = ""] = raw.split(".");
  const denom = 10n ** BigInt(fraction.length);
  const num = BigInt(whole + fraction) * factor;
  const value = (num + denom / 2n) / denom;
  const difference = num > value * denom ? num - value * denom : value * denom - num;
  return {
    value: value.toString(),
    // Error measured in unit one. Never silently round a genuine fractional stock unit.
    approximate: difference * 1000000n > denom * factor,
  };
}
function roundMoney(numerator: bigint, denominator: bigint, step: bigint): bigint {
  const divisor = denominator * step;
  return ((numerator + divisor / 2n) / divisor) * step;
}
function statusRow(row: Record<string, unknown>) {
  return {
    id: row.id, companyId: row.company_id, locationId: row.location_id,
    documentDate: row.document_date, sourceCount: row.source_count,
    cursor: row.cursor, changedCount: row.changed_count,
    unchangedCount: row.unchanged_count, roundedCount: row.rounded_count,
    failureCount: row.failure_count, failures: (row.failures as unknown[]).slice(0, 40),
    status: row.status, lastError: row.last_error ?? null,
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

export function openingInventoryRoutes(pool: Pool): Router {
  const router = Router(), base = "/companies/:companyId/opening-stock-imports";
  router.post(base, handler(async (req, res) => {
    const input = prepareSchema.parse(req.body);
    await readMaster(pool, req, "inventory.post");
    // Fixed Google Drive host and validated file ID: no arbitrary URL/SSRF.
    const response = await fetch(
      "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(input.fileId),
      { signal: AbortSignal.timeout(45000) },
    );
    if (!response.ok) fail("تعذر تنزيل المصدر من Google Drive");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 3000000) fail("ملف المصدر كبير جدًا");
    const zip = Buffer.from(await response.arrayBuffer());
    if (zip.length > 3000000 || zip.subarray(0, 2).toString() !== "PK")
      fail("المصدر ليس ZIP صالحًا أو يتجاوز الحجم المسموح");
    const hash = createHash("sha256").update(zip).digest("hex");
    if (hash !== input.expectedSha256) conflict("ملف المصدر تغير؛ لن تُستخدم نسخة غير مطابقة");
    const source = readSource(zip);
    if (source.length !== input.expectedCount) conflict("عدد صفوف الملف غير مطابق للعدد المتوقع");
    const run = await mutateMaster(pool, req, "inventory.post", async (client, user, companyId) => {
      await companyAccess(client, user, companyId, "finance.post");
      if (!user.owner) conflict("إدخال الرصيد الافتتاحي الجماعي مخصص لمالك الموقع");
      const existing = await client.query(
        "SELECT * FROM opening_inventory_runs WHERE company_id=$1 AND location_id=$2 AND source_sha256=$3",
        [companyId, input.locationId, hash],
      );
      if (existing.rows[0]) return existing.rows[0];
      const locations = await client.query(
        "SELECT id FROM locations WHERE company_id=$1 AND id=$2 AND active AND kind='showroom'",
        [companyId, input.locationId],
      );
      if (!locations.rowCount) conflict("موقع الافتتاحية يجب أن يكون معرض الشركة");
      const equity = await client.query(
        "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 AND active AND kind='posting' AND category='equity'",
        [companyId, input.equityAccountId],
      );
      if (!equity.rowCount) conflict("حدد حسابًا حركيًا فعالًا من حقوق الملكية للأرصدة الافتتاحية");
      const inventory = await requireInventorySettings(client, companyId);
      if (!inventory.allowNegative) conflict("السماح بالأرصدة السالبة مطلوب لهذه التسوية");
      const cards = await client.query(
        "SELECT legacy_id,factor2,factor3 FROM items WHERE company_id=$1",
        [companyId],
      );
      if (cards.rowCount !== source.length)
        conflict("عدد أصناف الشركة لا يطابق الملف، أوقفنا العملية دون تعديل المخزون");
      const mapping = new Map<string, bigint>();
      for (const item of cards.rows)
        mapping.set(String(item.legacy_id), BigInt(item.factor2) * BigInt(item.factor3));
      let roundedCount = 0;
      const targets: Target[] = source.map(entry => {
        const factor = mapping.get(entry.legacyId);
        if (factor === undefined) conflict("معرف الصنف غير موجود بالشركة: " + entry.legacyId);
        const converted = smallest(entry.quantity, factor);
        if (converted.approximate) roundedCount++;
        return { legacyId: entry.legacyId, smallest: converted.value, approximate: converted.approximate };
      });
      const inserted = await client.query(
        "INSERT INTO opening_inventory_runs(id,company_id,location_id,equity_account_id,source_file_id,source_sha256,source_items,source_count,document_date,rounded_count,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *",
        [randomUUID(), companyId, input.locationId, input.equityAccountId,
          input.fileId, hash, JSON.stringify(targets), targets.length,
          input.documentDate, roundedCount, user.id],
      );
      return inserted.rows[0];
    });
    res.status(201).json({ run: statusRow(run) });
  }));
  router.get(base + "/:runId", handler(async (req, res) => {
    const companyId = await readMaster(pool, req, "inventory.view");
    const runId = requestId.parse(req.params.runId);
    const query = await pool.query(
      "SELECT * FROM opening_inventory_runs WHERE company_id=$1 AND id=$2",
      [companyId, runId],
    );
    if (!query.rows[0]) throw new HttpError(404, "not_found", "عملية الافتتاحية غير موجودة");
    res.json({ run: statusRow(query.rows[0]) });
  }));
  const applyChunk = async (req: Request, runId: string, expectedCursor: number) => {
    const result = await mutateMaster(pool, req, "inventory.post", async (client, user, companyId) => {
      await companyAccess(client, user, companyId, "finance.post");
      if (!user.owner) conflict("إدخال الرصيد الافتتاحي الجماعي مخصص لمالك الموقع");
      const found = await client.query(
        "SELECT * FROM opening_inventory_runs WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [companyId, runId],
      );
      const run = found.rows[0];
      if (!run) throw new HttpError(404, "not_found", "عملية الافتتاحية غير موجودة");
      if (Number(run.cursor) !== expectedCursor)
        return { run: statusRow(run), cursorChanged: true };
      if (run.status === "completed") return { run: statusRow(run), cursorChanged: false };
      const inventory = await requireInventorySettings(client, companyId);
      if (!inventory.allowNegative) conflict("تم تعطيل السماح بالأرصدة السالبة");
      const loc = await client.query(
        "SELECT branch_id FROM locations WHERE company_id=$1 AND id=$2 AND active AND kind='showroom'",
        [companyId, run.location_id],
      );
      if (!loc.rows[0]) conflict("موقع المعرض لم يعد فعالًا");
      const account = await client.query(
        "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 AND active AND kind='posting' AND category='equity'",
        [companyId, run.equity_account_id],
      );
      if (!account.rows[0]) conflict("حساب الافتتاحية غير متاح");
      const targets = run.source_items as Target[];
      const end = Math.min(Number(run.cursor) + 100, targets.length);
      const docDate = new Date(run.document_date).toISOString().slice(0, 10);
      const failures = run.failures as { legacyId: string; reason: string }[];
      let changed = 0, unchanged = 0, signedTotal = 0n;
      let sharedOperationId: number | null = null;
      // Read current balances once for the batch. Zero in both source and
      // showroom remains untouched: no valuation, operation or journal row.
      const currentRows = await client.query(
        `SELECT i.legacy_id, COALESCE(SUM(s.quantity_smallest),0)::text AS quantity
         FROM items i LEFT JOIN stock_balances s
           ON s.company_id=i.company_id AND s.item_id=i.id AND s.location_id=$2
         WHERE i.company_id=$1 AND i.legacy_id=ANY($3::text[])
         GROUP BY i.legacy_id`,
        [companyId,run.location_id,targets.slice(Number(run.cursor),end).map(t => t.legacyId)],
      );
      const currentByLegacyId = new Map<string,string>(
        currentRows.rows.map(row => [String(row.legacy_id),String(row.quantity)]),
      );
      for (let pos = Number(run.cursor); pos < end; pos++) {
        const target = targets[pos];
        if (currentByLegacyId.get(target.legacyId) === target.smallest) {
          unchanged++;
          continue;
        }
        if (target.approximate) {
          failures.push({ legacyId: target.legacyId, reason: "الكسر لا يمثل عددًا صحيحًا من أصغر وحدة للصنف" });
          continue;
        }
        await client.query("SAVEPOINT opening_inventory_item");
        const previousOperationId = sharedOperationId;
        try {
          const itemResult = await client.query(
            "SELECT id,code,name,factor2,factor3,purchase_price,currency_id,has_expiry FROM items WHERE company_id=$1 AND legacy_id=$2 FOR SHARE",
            [companyId, target.legacyId],
          );
          const item = itemResult.rows[0];
          if (!item) conflict("تعذرت مطابقة معرف الصنف القديم");
          await client.query(
            "INSERT INTO stock_item_valuations(company_id,item_id,quantity_smallest,value_base) VALUES($1,$2,0,0) ON CONFLICT(company_id,item_id) DO NOTHING",
            [companyId, item.id],
          );
          const values = (await client.query(
            "SELECT quantity_smallest,value_base FROM stock_item_valuations WHERE company_id=$1 AND item_id=$2 FOR UPDATE",
            [companyId,item.id],
          )).rows[0];
          const batches = await client.query(
            "SELECT batch_key,quantity_smallest FROM stock_balances WHERE company_id=$1 AND location_id=$2 AND item_id=$3 ORDER BY batch_key FOR UPDATE",
            [companyId,run.location_id,item.id],
          );
          const current = batches.rows.reduce(
            (total: bigint,row: { quantity_smallest: string }) => total + BigInt(row.quantity_smallest), 0n,
          );
          const delta = BigInt(target.smallest) - current;
          if (delta === 0n) {
            unchanged++;
            await client.query("RELEASE SAVEPOINT opening_inventory_item");
            continue;
          }
          const factor = BigInt(item.factor2) * BigInt(item.factor3);
          let cost: bigint | undefined;
          if (delta > 0n) {
            const pooledQuantity = BigInt(values.quantity_smallest);
            const pooledValue = moneyUnits(values.value_base);
            const step = quantum(inventory.baseDecimalPlaces);
            if (pooledQuantity > 0n && pooledValue > 0n) {
              cost = roundMoney(pooledValue * delta, pooledQuantity, step);
            } else {
              let rate = "1";
              if (item.currency_id !== inventory.baseCurrencyId) {
                const rates = await client.query(
                  "SELECT rate FROM exchange_rates WHERE company_id=$1 AND currency_id=$2 AND base_currency_id=$3 AND active AND effective_at < (($4::date+1)::timestamp AT TIME ZONE 'UTC') ORDER BY effective_at DESC,id DESC LIMIT 1",
                  [companyId,item.currency_id,inventory.baseCurrencyId,docDate],
                );
                if (!rates.rows[0]) conflict("سعر تحويل عملة تكلفة الصنف غير موجود");
                rate = rates.rows[0].rate;
              }
              const priceBase = convertedUnits(String(item.purchase_price),rate,inventory.baseDecimalPlaces);
              cost = roundMoney(priceBase * delta, factor, step);
            }
            if (cost <= 0n) conflict("لا توجد تكلفة موجبة قابلة للتسجيل لهذا الرصيد");
          }
          const batch = item.has_expiry && delta > 0n
            ? batches.rows.find((b: { quantity_smallest: string; batch_key: string }) =>
              BigInt(b.quantity_smallest) > 0n && Boolean(b.batch_key))
            : undefined;
          if (sharedOperationId === null) {
            sharedOperationId = await createStockOperation(client,companyId,user,"adjustment",{
              documentDate:docDate,
              description:"أرصدة افتتاحية للمعرض - المصدر " + run.source_file_id
                + " - الدفعة " + String(Math.floor(Number(run.cursor) / 100) + 1),
              idempotencyKey:randomUUID(),
            });
          }
          const movement = await applyStock(client,companyId,user.id,{
            itemId:item.id,locationId:run.location_id,quantitySmallest:delta,
            costBase:cost,kind:delta > 0n ? "adjustment_surplus" : "adjustment_shortage",
            documentDate:docDate,expiryDate:batch?.batch_key ?? null,operationId:sharedOperationId,
            allowExpired:true,allowInactive:true,allowUnknownExpiry:true,
          });
          const check = await client.query(
            "SELECT COALESCE(sum(quantity_smallest),0)::text AS total FROM stock_balances WHERE company_id=$1 AND location_id=$2 AND item_id=$3",
            [companyId,run.location_id,item.id],
          );
          if (check.rows[0].total !== target.smallest)
            conflict("الرصيد الناتج لم يطابق الملف");
          signedTotal += movement.costBase;
          changed++;
          await client.query("RELEASE SAVEPOINT opening_inventory_item");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT opening_inventory_item");
          sharedOperationId = previousOperationId;
          await client.query("RELEASE SAVEPOINT opening_inventory_item");
          failures.push({
            legacyId:target.legacyId,
            reason:(error instanceof Error ? error.message : String(error)).slice(0,250),
          });
        }
      }
      if (sharedOperationId !== null) {
        await auditStockOperation(client,companyId,user,sharedOperationId,{
          sourceRunId:runId,locationId:run.location_id,sourceCursor:Number(run.cursor),
        });
      }
      if (signedTotal !== 0n) {
        const amount = moneyString(signedTotal > 0n ? signedTotal : -signedTotal);
        const increase = signedTotal > 0n;
        const documentId = await postCommerceJournal(client,companyId,user,{
          documentDate:docDate,branchId:loc.rows[0].branch_id,
          currencyId:inventory.baseCurrencyId,
          description:"رصيد افتتاحي لمخزون المعرض - دفعة من " + runId,
          idempotencyKey:randomUUID(),
          lines: [
            { accountId:increase ? inventory.inventoryAccountId : run.equity_account_id,
              debit:amount,credit:"0",description:"أرصدة افتتاحية المخزون" },
            { accountId:increase ? run.equity_account_id : inventory.inventoryAccountId,
              debit:"0",credit:amount,description:"مقابل الأرصدة الافتتاحية" },
          ],
        });
        await client.query(
          "UPDATE stock_operations SET financial_document_id=$1 WHERE company_id=$2 AND id=$3",
          [documentId,companyId,sharedOperationId],
        );
      }
      const completed = end === targets.length;
      const updated = await client.query(
        "UPDATE opening_inventory_runs SET cursor=$1,changed_count=changed_count+$2,unchanged_count=unchanged_count+$3,failure_count=$4,failures=$5::jsonb,status=$6,updated_at=now(),completed_at=CASE WHEN $7 THEN now() ELSE NULL END WHERE id=$8 AND company_id=$9 RETURNING *",
        [end,changed,unchanged,failures.length,JSON.stringify(failures),
          completed ? "completed" : "processing",completed,runId,companyId],
      );
      return { run:statusRow(updated.rows[0]),cursorChanged:false };
    });
    return result;
  };
  router.post(base + "/:runId/apply", handler(async (req, res) => {
    const runId = requestId.parse(req.params.runId);
    const body = z.object({ expectedCursor: z.number().int().nonnegative() }).strict().parse(req.body);
    res.json(await applyChunk(req,runId,body.expectedCursor));
  }));
  router.post(base + "/:runId/start", handler(async (req, res) => {
    const runId = requestId.parse(req.params.runId);
    const companyId = await readMaster(pool,req,"inventory.post");
    if (!actor(req).owner) conflict("عملية الافتتاحية محصورة بمالك الموقع");
    const found = await pool.query(
      "SELECT cursor,status FROM opening_inventory_runs WHERE id=$1 AND company_id=$2",
      [runId,companyId],
    );
    if (!found.rows[0]) throw new HttpError(404,"not_found","عملية الافتتاحية غير موجودة");
    const active = activeWorkers.get(runId);
    if (active) { res.status(202).json({ running:true, cursor:found.rows[0].cursor }); return; }
    if (found.rows[0].status === "completed") {
      res.json({ running:false,completed:true,cursor:found.rows[0].cursor });return;
    }
    const worker = { stopped:false };
    activeWorkers.set(runId,worker);
    // Preserve the verified acting user after the MCP dispatch restores its req.
    const workReq = Object.assign(Object.create(Object.getPrototypeOf(req)),req,{
      auth:req.auth ? { ...req.auth } : undefined,
      params: { ...req.params },
    }) as Request;
    res.status(202).json({ running:true,cursor:found.rows[0].cursor });
    setImmediate(() => {
      void (async () => {
        try {
          let cursor = Number(found.rows[0].cursor);
          while (!worker.stopped) {
            const outcome = await applyChunk(workReq,runId,cursor);
            const next = Number(outcome.run.cursor);
            if (outcome.run.status === "completed") break;
            if (next === cursor) throw new Error("Opening batch did not advance cursor");
            cursor = next;
            // Yield between batches so other website requests are served.
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        } catch(error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await pool.query(
              "UPDATE opening_inventory_runs SET last_error=$1,updated_at=now() WHERE id=$2 AND company_id=$3",
              [message.slice(0,1000),runId,companyId],
            );
          } catch(e) { console.error("OPENING_STOCK_ERROR_UPDATE",e); }
          console.error("OPENING_STOCK_PROCESSING_FAILED",message);
        } finally { activeWorkers.delete(runId); }
      })();
    });
  }));
  router.post(base + "/:runId/stop", handler(async (req,res) => {
    await readMaster(pool,req,"inventory.post");
    if(!actor(req).owner) conflict("إيقاف العملية محصور بمالك الموقع");
    const runId=requestId.parse(req.params.runId);
    const worker=activeWorkers.get(runId);
    if(worker) worker.stopped=true;
    res.json({stopRequested:Boolean(worker)});
  }));
  return router;
}

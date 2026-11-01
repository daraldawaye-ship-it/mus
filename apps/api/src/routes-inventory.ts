import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import {
  inventorySettingsSchema,
  stockTransferSchema,
  stockAdjustmentSchema,
  stockMovementKinds,
  countedStockSmallest,
} from "../../../packages/contracts/src/inventory.ts";
import { documentDateSchema } from "../../../packages/contracts/src/finance.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { isItemDueForCount } from "./routes-tasks.ts";
import { awardRequiredStockCount } from "./services/stock-count-rewards.ts";
import { conflict, masterPage, mutateMaster } from "./services/masters.ts";
import {
  checkQuantum,
  convertedUnits,
  moneyString,
  moneyUnits,
  quantum,
} from "./services/finance.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { addItemCoverageToPage, canReadItemCoverage, itemCoverageJoin, itemCoverageSelect, itemCoverageRedactedSelect } from "./services/item-coverage.ts";
import { postCommerceJournal } from "./services/commerce-ledger.ts";
import {
  applyStock,
  assertStockChronology,
  auditStockOperation,
  checkStockLocation,
  createStockOperation,
  findStockOperation,
  getInventorySettings,
  fractionQuantity,
  itemStockSnapshot,
  loadStockOperation,
  requireInventorySettings,
  stockBalanceDTO,
  stockBalanceFrom,
  stockBalanceSelect,
  stockMovementDTO,
  stockMovementFrom,
  stockMovementSelect,
  stockUnitMultiplier,
} from "./services/inventory.ts";

async function readInventory<T>(
  pool: Pool,
  req: Request,
  action: (client: PoolClient, companyId: number) => Promise<T>,
): Promise<T> {
  const companyId = id(req.params.companyId);
  return transaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, "inventory.view");
    return action(client, companyId);
  });
}
const balanceColumns = {
  id: "s.id",
  itemId: "s.item_id",
  itemCode: "i.code",
  itemName: "i.name",
  locationId: "s.location_id",
  locationName: "l.name",
  branchName: "b.name",
  expiryDate: "COALESCE(NULLIF(s.batch_key,''),'none')",
  quantitySmallest: "s.quantity_smallest",
  quantityUnit1: "s.quantity_smallest::numeric/(i.factor2::numeric*i.factor3)",
  pooledQuantityUnit1: "v.quantity_smallest::numeric/(i.factor2::numeric*i.factor3)",
  pooledQuantitySmallest: "v.quantity_smallest",
  pooledValueBase: "v.value_base",
};
const movementColumns = {
  id: "m.id",
  supplierAccountId: "COALESCE(m.supplier_account_id,supplier_hint.supplier_account_id)",
  itemId: "m.item_id",
  itemCode: "i.code",
  itemName: "i.name",
  locationId: "m.location_id",
  locationName: "l.name",
  branchId: "l.branch_id",
  branchName: "b.name",
  expiryDate: "m.batch_key",
  quantitySmallest: "m.quantity_smallest",
  costBase: "m.cost_base",
  kind: "m.kind",
  documentDate: "m.document_date",
  createdAt: "m.created_at",
  createdBy: "m.created_by",
  createdByName: "u.display_name",
  invoiceId: "m.invoice_id",
  operationId: "m.operation_id",
};

export function inventoryRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  router.get(
    `${base}/stock-operations/:id`,
    handler(async (req, res) => {
      const operationId = id(req.params.id);
      res.json(
        await readInventory(pool, req, async (client, companyId) => ({
          operation: await loadStockOperation(client, companyId, operationId),
        })),
      );
    }),
  );
  router.get(
    `${base}/inventory-settings`,
    handler(async (req, res) => {
      res.json(
        await readInventory(pool, req, async (client, companyId) => ({
          settings: await getInventorySettings(client, companyId),
        })),
      );
    }),
  );
  router.put(
    `${base}/inventory-settings`,
    handler(async (req, res) => {
      const input = parse(inventorySettingsSchema, req.body);
      const settings = await mutateMaster(
        pool,
        req,
        "inventory.manage",
        async (client, user, companyId) => {
          const before = await getInventorySettings(client, companyId);
          if ((before?.revision ?? null) !== input.revision)
            conflict("تم تعديل إعدادات المخزون؛ أعد تحميلها قبل الحفظ");
          if (
            before &&
            (
              [
                "inventoryAccountId",
                "salesAccountId",
                "cogsAccountId",
                "surplusAccountId",
                "shortageAccountId",
              ] as const
            ).some((field) => before[field] !== input[field])
          ) {
            const history = await client.query(
              "SELECT 1 FROM stock_movements WHERE company_id=$1 LIMIT 1",
              [companyId],
            );
            if (history.rowCount)
              conflict(
                "حسابات المخزون مثبتة بعد أول حركة؛ تغييرها يحتاج تسوية محاسبية مستقلة",
              );
          }
          const pairs = [
            [input.inventoryAccountId, "asset"],
            [input.salesAccountId, "income"],
            [input.cogsAccountId, "expense"],
            [input.surplusAccountId, "income"],
            [input.shortageAccountId, "expense"],
          ] as const;
          if (new Set(pairs.map(([accountId]) => accountId)).size !== 5)
            conflict(
              "حدد خمسة حسابات مختلفة للمخزون والمبيعات والتكلفة وفروق الجرد",
            );
          const accounts = await client.query(
            "SELECT id,category FROM accounts WHERE company_id=$1 AND id=ANY($2::integer[]) AND active AND kind='posting' FOR SHARE",
            [companyId, pairs.map(([accountId]) => accountId)],
          );
          if (
            pairs.some(
              ([accountId, category]) =>
                !accounts.rows.some(
                  (row) => row.id === accountId && row.category === category,
                ),
            )
          )
            conflict(
              "اختر حسابات حركية فعالة من الشركة: المخزون أصل، المبيعات والزيادة إيراد، والتكلفة والعجز مصروف",
            );
          await client.query(
            `INSERT INTO inventory_settings(company_id,inventory_account_id,sales_account_id,cogs_account_id,surplus_account_id,shortage_account_id,costing_method,allow_negative,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,'weighted_average',$8,$7)
        ON CONFLICT(company_id) DO UPDATE SET inventory_account_id=EXCLUDED.inventory_account_id,sales_account_id=EXCLUDED.sales_account_id,
        cogs_account_id=EXCLUDED.cogs_account_id,surplus_account_id=EXCLUDED.surplus_account_id,shortage_account_id=EXCLUDED.shortage_account_id,
        allow_negative=EXCLUDED.allow_negative,
        revision=inventory_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
            [
              companyId,
              input.inventoryAccountId,
              input.salesAccountId,
              input.cogsAccountId,
              input.surplusAccountId,
              input.shortageAccountId,
              user.id,
              input.allowNegative,
            ],
          );
          const after = await getInventorySettings(client, companyId);
          await audit(
            client,
            user,
            "inventory.settings",
            "inventorySettings",
            companyId,
            before,
            after,
            companyId,
          );
          return after;
        },
      );
      res.json({ settings });
    }),
  );
  // Exact physical-count preview, summed across every batch for the item/location.
  /** All company locations, including empty sites and the returns type,
   * aggregated across batches for the selected item. No expiry controls here. */
  router.get(
    `${base}/item-location-balances`,
    handler(async (req, res) => {
      if (typeof req.query.itemId !== "string")
        throw new HttpError(400, "invalid_query", "اختر الصنف المطلوب");
      const itemId = id(req.query.itemId);
      res.json(await readInventory(pool, req, async (client, companyId) => {
        const item = (await client.query(
          "SELECT factor2,factor3,unit1_name FROM items WHERE company_id=$1 AND id=$2",
          [companyId,itemId],
        )).rows[0];
        if (!item) throw new HttpError(404,"not_found","الصنف غير موجود");
        const balances = await client.query(
          `SELECT l.id,l.company_id,l.branch_id,l.code,l.name,l.kind,l.active,
                  l.created_by,l.created_at,
                  b.name AS branch_name,b.active AS branch_active,
                  COALESCE(sb.quantity_smallest,0)::text AS quantity_smallest
           FROM locations l
           JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id
           LEFT JOIN (
             SELECT location_id,SUM(quantity_smallest) AS quantity_smallest
             FROM stock_balances WHERE company_id=$1 AND item_id=$2
             GROUP BY location_id
           ) sb ON sb.location_id=l.id
           WHERE l.company_id=$1
           ORDER BY b.name,
             CASE l.kind WHEN 'showroom' THEN 1 WHEN 'warehouse' THEN 2 ELSE 3 END,
             l.name,l.id`,
          [companyId,itemId],
        );
        const multiplier=BigInt(item.factor2)*BigInt(item.factor3);
        return {
          itemId,
          items:balances.rows.map(row=>({
            location:{
              id:row.id,companyId:row.company_id,branchId:row.branch_id,
              code:row.code,name:row.name,kind:row.kind,active:row.active,
              branchName:row.branch_name,branchActive:row.branch_active,
              effectiveActive:row.active && row.branch_active,
              createdBy:row.created_by,createdAt:new Date(row.created_at).toISOString(),
            },
            quantitySmallest:row.quantity_smallest,
            quantityUnit1:fractionQuantity(BigInt(row.quantity_smallest),multiplier),
            unit1Name:item.unit1_name,
          })),
        };
      }));
    }),
  );
  router.get(
    `${base}/stock-count-snapshot`,
    handler(async (req, res) => {
      if (typeof req.query.itemId !== "string" || typeof req.query.locationId !== "string")
        throw new HttpError(400,"invalid_query","اختر الصنف وموقع الجرد.");
      const itemId = id(req.query.itemId);
      const locationId = id(req.query.locationId);
      res.json(await readInventory(pool, req, async (client, companyId) => {
        const result = await client.query(
          `SELECT COALESCE(SUM(quantity_smallest),0)::text AS "quantitySmallest",
             COUNT(*) FILTER (WHERE quantity_smallest<>0)::integer AS "batchCount"
           FROM stock_balances
           WHERE company_id=$1 AND item_id=$2 AND location_id=$3`,
          [companyId,itemId,locationId],
        );
        return result.rows[0];
      }));
    }),
  );
  router.get(
    `${base}/stock-balances`,
    handler(async (req, res) => {
      let expiry: string | undefined;
      if (req.query.expiryDate !== undefined) {
        if (typeof req.query.expiryDate !== "string")
          throw new HttpError(400, "invalid_query", "تاريخ الدفعة غير صالح");
        expiry =
          req.query.expiryDate === "none"
            ? "none"
            : parse(documentDateSchema, req.query.expiryDate);
      }
      res.json(
        await readInventory(pool, req, async (client, companyId) => {
          const canViewCoverage = await canReadItemCoverage(client, actor(req), companyId);
          const sortByCoverage = canViewCoverage && typeof req.query.sort === "string"
            && req.query.sort.split(",").some(value =>
              ["approximateCoverageDays", "coverageAfterReserveDays"].includes(value.split(":")[0]));
          const from = stockBalanceFrom + (sortByCoverage ? itemCoverageJoin : "");
          const select = stockBalanceSelect.replace(stockBalanceFrom,
            `${sortByCoverage ? itemCoverageSelect : itemCoverageRedactedSelect} ${from}`);
          const result = await masterPage(
            client,
            req,
            companyId,
            select,
            from,
            "s",
            {
              ...balanceColumns,
              approximateCoverageDays: sortByCoverage ? "coverage.approximate_coverage_days" : "NULL::numeric",
              coverageAfterReserveDays: sortByCoverage ? "coverage.coverage_after_reserve_days" : "NULL::numeric",
            },
            ["i.code", "i.name", "l.name", "b.name"],
            stockBalanceDTO,
            {
              itemId: "id",
              locationId: "id",
              expiryDate: expiry === undefined ? [] : [expiry],
            },
            "itemCode:asc,locationName:asc,expiryDate:asc",
          );
          if (canViewCoverage && !sortByCoverage)
            result.items = await addItemCoverageToPage(client, companyId, result.items, row => row.itemId);
          return result;
        }),
      );
    }),
  );
  router.get(
    `${base}/stock-movements`,
    handler(async (req, res) => {
      res.json(
        await readInventory(pool, req, async (client, companyId) => {
          const query = listQuery(
            req.query,
            movementColumns,
            "documentDate:desc,id:desc",
          );
          const parameters: unknown[] = [companyId, searchPattern(query.q)];
          let where =
            "m.company_id=$1 AND (i.code ILIKE $2 OR i.name ILIKE $2 OR l.name ILIKE $2 OR b.name ILIKE $2 OR u.display_name ILIKE $2 OR COALESCE(m.supplier_account_code,supplier_hint.supplier_account_code) ILIKE $2 OR COALESCE(m.supplier_account_name,supplier_hint.supplier_account_name) ILIKE $2 OR COALESCE(doctor_invoice.doctor_name,'') ILIKE $2)";
          if (req.query.doctorId !== undefined) {
            if (typeof req.query.doctorId !== "string")
              throw new HttpError(400, "invalid_query", "معرف الطبيب أو الجهة غير صالح");
            parameters.push(id(req.query.doctorId));
            where += ` AND doctor_invoice.doctor_id=${parameters.length}`;
          }
          for (const key of [
            "itemId",
            "locationId",
            "supplierAccountId",
            "branchId",
            "createdBy",
            "invoiceId",
            "operationId",
          ] as const) {
            const value = req.query[key];
            if (value === undefined) continue;
            if (typeof value !== "string")
              throw new HttpError(400, "invalid_query", "معرف فلتر الحركة غير صالح");
            parameters.push(id(value));
            where += ` AND ${movementColumns[key]}=$${parameters.length}`;
          }
          if (req.query.kind !== undefined) {
            if (
              typeof req.query.kind !== "string" ||
              !stockMovementKinds.includes(
                req.query.kind as (typeof stockMovementKinds)[number],
              )
            )
              throw new HttpError(
                400,
                "invalid_query",
                "نوع حركة المخزون غير صالح",
              );
            parameters.push(req.query.kind);
            where += ` AND m.kind=$${parameters.length}`;
          }
          let from: string | undefined, to: string | undefined;
          for (const key of ["dateFrom", "dateTo"] as const) {
            if (req.query[key] === undefined) continue;
            const date = parse(documentDateSchema, req.query[key]);
            if (key === "dateFrom") from = date;
            else to = date;
            parameters.push(date);
            where += ` AND m.document_date${key === "dateFrom" ? ">=" : "<="}$${parameters.length}`;
          }
          if (from && to && from > to)
            throw new HttpError(
              400,
              "invalid_query",
              "بداية الفترة بعد نهايتها",
            );
          const count = await client.query(
            `SELECT count(*)::integer AS total ${stockMovementFrom} WHERE ${where}`,
            parameters,
          );
          const rows = await client.query(
            `${stockMovementSelect} WHERE ${where} ORDER BY ${query.order} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
            [...parameters, query.pageSize, query.offset],
          );
          return {
            items: rows.rows.map(stockMovementDTO),
            total: count.rows[0].total as number,
            page: query.page,
            pageSize: query.pageSize,
          };
        }),
      );
    }),
  );
  router.post(
    `${base}/stock-transfers`,
    handler(async (req, res) => {
      const input = parse(stockTransferSchema, req.body);
      const result = await mutateMaster(
        pool,
        req,
        "inventory.post",
        async (client, user, companyId) => {
          const previous = await findStockOperation(
            client,
            companyId,
            input.idempotencyKey,
            input,
          );
          if (previous !== null)
            return {
              created: false,
              operation: await loadStockOperation(client, companyId, previous),
            };
          const item = await itemStockSnapshot(client, companyId, input.itemId);
          await checkStockLocation(client, companyId, input.fromLocationId);
          await checkStockLocation(client, companyId, input.toLocationId);
          const quantity =
            BigInt(input.quantity) * stockUnitMultiplier(item, input.unit);
          const operationId = await createStockOperation(
            client,
            companyId,
            user,
            "transfer",
            input,
          );
          const taken = await applyStock(client, companyId, user.id, {
            itemId: input.itemId,
            locationId: input.fromLocationId,
            quantitySmallest: -quantity,
            kind: "transfer_out",
            documentDate: input.documentDate,
            expiryDate: input.expiryDate,
            operationId,
            allowExpired: true,
          });
          for (const batch of taken.allocations)
            await applyStock(client, companyId, user.id, {
              itemId: input.itemId,
              locationId: input.toLocationId,
              quantitySmallest: -BigInt(batch.quantitySmallest),
              costBase: -moneyUnits(batch.costBase),
              kind: "transfer_in",
              documentDate: input.documentDate,
              expiryDate: batch.expiryDate,
              operationId,
              originalMovementId: batch.movementId,
              allowExpired: true,
            });
          return {
            created: true,
            operation: await auditStockOperation(
              client,
              companyId,
              user,
              operationId,
            ),
          };
        },
      );
      res
        .status(result.created ? 201 : 200)
        .json({ operation: result.operation });
    }),
  );
  router.post(
    `${base}/stock-adjustments`,
    handler(async (req, res) => {
      const input = parse(stockAdjustmentSchema, req.body);
      const fromRequiredTask = req.query.taskSource === "required-count";
      const result = await mutateMaster(
        pool,
        req,
        "inventory.post",
        async (client, user, companyId) => {
          await companyAccess(client, user, companyId, "finance.post");
          const previous = await findStockOperation(
            client,
            companyId,
            input.idempotencyKey,
            input,
          );
          if (previous !== null)
            return {
              created: false,
              operation: await loadStockOperation(client, companyId, previous),
            };
          const item = await itemStockSnapshot(client, companyId, input.itemId);
          const location = await checkStockLocation(
            client,
            companyId,
            input.locationId,
          );
          const settings = await requireInventorySettings(client, companyId);
          // The settlement follow-up's "due only" filter is the reward source.
          // Evaluate BEFORE posting; a count changes the last-count pointer.
          const eligibleForReward = !input.zeroLocation &&
            !!(await client.query("SELECT 1 FROM locations WHERE company_id=$1 AND id=$2 AND kind='showroom'",[companyId,input.locationId])).rowCount &&
            await isItemDueForCount(client,companyId,input.itemId);
          const eligibleForTask = fromRequiredTask && eligibleForReward;
          await assertStockChronology(
            client,
            companyId,
            input.itemId,
            input.documentDate,
          );
          // Reconcile the physical TOTAL while retaining each expiry batch.
          // The nearest-expiry field updates the item card, never rebatches stock.
          const existingBatches = await client.query(
            `SELECT batch_key,quantity_smallest::text AS quantity_smallest
             FROM stock_balances
             WHERE company_id=$1 AND item_id=$2 AND location_id=$3
             ORDER BY batch_key ASC FOR UPDATE`,
            [companyId,input.itemId,input.locationId],
          );
          const allBatches = existingBatches.rows as {
            batch_key: string; quantity_smallest: string;
          }[];
          const aggregateCount = input.expiryDate === null;
          const current = allBatches.reduce((total,row) =>
            total + (aggregateCount || row.batch_key === input.expiryDate
              ? BigInt(row.quantity_smallest) : 0n),0n);
          if (current !== BigInt(input.expectedQuantitySmallest))
            conflict("تغير إجمالي رصيد الصنف أثناء الجرد؛ أعد تحميل الرصيد وراجع الكمية المعدودة.");
          let movementExpiryDate: string | null = input.expiryDate;
          if (!item.hasExpiry && movementExpiryDate !== null)
            conflict("الصنف لا يتتبع تاريخ انتهاء");
          if (input.nearestExpiryDate !== undefined && !item.hasExpiry && input.nearestExpiryDate !== null)
            conflict("لا يمكن تعيين تاريخ انتهاء لصنف لا يتتبع الانتهاء");
          // The shelf is company scoped, and never accepts a made-up label.
          // Retain an existing archived shelf, but do not assign it anew.
          let shelfName: string | undefined;
          if (input.shelfId !== undefined) {
            if (input.shelfId === null) {
              shelfName = "";
            } else {
              const shelf = await client.query(
                "SELECT name,archived FROM item_shelves WHERE company_id=$1 AND id=$2 FOR SHARE",
                [companyId,input.shelfId],
              );
              if (!shelf.rows[0])
                conflict("الرف المحدد غير موجود في هذه الشركة");
              if (shelf.rows[0].archived) {
                const old = await client.query(
                  "SELECT shelf_id FROM items WHERE company_id=$1 AND id=$2",
                  [companyId,input.itemId],
                );
                if (old.rows[0]?.shelf_id !== input.shelfId)
                  conflict("لا يمكن تعيين رف مؤرشف للصنف");
              }
              shelfName = shelf.rows[0].name;
            }
          }
          const multiplier = stockUnitMultiplier(item, input.unit);
          let counted: bigint;
          if (input.countedUnits) {
            if (item.factor2 <= 1 && input.countedUnits.unit2 !== undefined)
              conflict("الوحدة الثانية غير مفعلة في كرت هذا الصنف");
            if (item.factor3 <= 1 && input.countedUnits.unit3 !== undefined)
              conflict("الوحدة الثالثة غير مفعلة في كرت هذا الصنف");
            counted = countedStockSmallest(input.countedUnits, item);
          } else {
            counted = BigInt(input.countedQuantity!) * multiplier;
          }
          let compositionNeedsLink = false;
          if (input.zeroLocation) {
            if (counted !== 0n || input.nearestExpiryDate !== undefined ||
                input.shelfId !== undefined || input.compositionId !== undefined ||
                input.expiryDate !== null)
              conflict("تصفير الموقع لا يغير الرف أو التركيب أو أقرب تاريخ انتهاء في كرت الصنف.");
          } else if (input.countedUnits) {
            // New all-unit reconciliations require classification and shelf.
            // Legacy single-quantity count requests remain compatible.
            if (input.shelfId == null)
              conflict("اختيار رف الصنف إلزامي عند تسوية الجرد.");
            if (item.hasExpiry && !input.nearestExpiryDate)
              conflict("أدخل أقرب تاريخ انتهاء للصنف قبل ترحيل التسوية.");
            const card = await client.query(
              "SELECT composition_id FROM items WHERE company_id=$1 AND id=$2 FOR SHARE",
              [companyId, input.itemId],
            );
            const linkedId: number | null = card.rows[0]?.composition_id ?? null;
            if (linkedId === null) {
              if (input.compositionId === undefined)
                conflict("هذا الصنف بدون تركيب. اختر التركيب قبل حفظ التسوية.");
              const composition = await client.query(
                "SELECT active FROM item_compositions WHERE company_id=$1 AND id=$2 FOR SHARE",
                [companyId, input.compositionId],
              );
              if (!composition.rows[0]?.active)
                conflict("اختر تركيبًا فعالًا من تراكيب الشركة.");
              compositionNeedsLink = true;
            } else if (input.compositionId !== undefined && input.compositionId !== linkedId) {
              conflict("تم تغيير تركيب الصنف؛ أعد تحميل كرت الصنف قبل التسوية.");
            }
          }
          const delta = counted - current;
          // Surplus joins an existing batch (the earliest available expiry),
          // while shortage consumes all available batches FEFO without
          // inventing or changing their expiration dates.
          if (aggregateCount) {
            if (delta > 0n && item.hasExpiry) {
              movementExpiryDate =
                allBatches.find(row => BigInt(row.quantity_smallest)>0n && row.batch_key)?.batch_key
                || input.nearestExpiryDate
                || (await client.query(
                  "SELECT nearest_expiry_date::text AS expiry FROM items WHERE company_id=$1 AND id=$2",
                  [companyId,input.itemId],
                )).rows[0]?.expiry
                || null;
              if (!movementExpiryDate)
                conflict("حدد أقرب تاريخ انتهاء للصنف لبدء تسوية زيادة المخزون.");
            } else {
              movementExpiryDate = null;
            }
          }

          // When the UI omits the cost, derive it from the item's own purchase
          // price, converted at the effective exchange rate on document date.
          // Legacy requests with an explicit cost remain backward compatible.
          let unitCostBase = input.unitCostBase ?? "0";
          if (delta > 0n && input.unitCostBase === undefined) {
            const purchase = await client.query(
              "SELECT purchase_price,currency_id FROM items WHERE company_id=$1 AND id=$2 FOR SHARE",
              [companyId,input.itemId],
            );
            let rate = "1";
            if (purchase.rows[0].currency_id !== settings.baseCurrencyId) {
              const rates = await client.query(
                `SELECT rate FROM exchange_rates
                 WHERE company_id=$1 AND currency_id=$2 AND base_currency_id=$3
                 AND active AND effective_at < (($4::date+1)::timestamp AT TIME ZONE 'UTC')
                 ORDER BY effective_at DESC,id DESC LIMIT 1`,
                [companyId,purchase.rows[0].currency_id,settings.baseCurrencyId,input.documentDate],
              );
              if (!rates.rows[0]) conflict("عرّف سعر صرف عملة الصنف قبل تسوية زيادة المخزون");
              rate = rates.rows[0].rate;
            }
            unitCostBase = moneyString(convertedUnits(
              purchase.rows[0].purchase_price,rate,settings.baseDecimalPlaces,
            ));
          }
          checkQuantum(unitCostBase, settings.baseDecimalPlaces);
          const operationId = await createStockOperation(
            client,
            companyId,
            user,
            "adjustment",
            input,
          );
          if (eligibleForTask) await client.query(
            "INSERT INTO automatic_task_count_events(company_id,operation_id,item_id,actor_user_id) VALUES($1,$2,$3,$4)",
            [companyId,operationId,input.itemId,user.id],
          );
          if (delta !== 0n) {
            let cost: bigint | undefined;
            if (delta > 0n) {
              const divisor = multiplier * quantum(settings.baseDecimalPlaces),
                numerator = moneyUnits(unitCostBase) * delta;
              cost =
                (numerator / divisor +
                  ((numerator % divisor) * 2n >= divisor ? 1n : 0n)) *
                quantum(settings.baseDecimalPlaces);
              if (cost <= 0n)
                conflict(
                  "زيادة الجرد تحتاج تكلفة موجبة بالعملة الأساسية؛ قد تكون التكلفة المدخلة أقل من دقة العملة",
                );
            }
            const movement = await applyStock(client, companyId, user.id, {
              itemId: input.itemId,
              locationId: input.locationId,
              quantitySmallest: delta,
              costBase: cost,
              kind: delta > 0n ? "adjustment_surplus" : "adjustment_shortage",
              documentDate: input.documentDate,
              expiryDate: movementExpiryDate,
              operationId,
              allowExpired: true,
            });
            const amount =
              movement.costBase < 0n ? -movement.costBase : movement.costBase;
            if (amount > 0n) {
              const debitId =
                  delta > 0n
                    ? settings.inventoryAccountId
                    : settings.shortageAccountId,
                creditId =
                  delta > 0n
                    ? settings.surplusAccountId
                    : settings.inventoryAccountId;
              const financialDocumentId = await postCommerceJournal(
                client,
                companyId,
                user,
                {
                  documentDate: input.documentDate,
                  branchId: location.branchId,
                  currencyId: settings.baseCurrencyId,
                  description: `تسوية جرد الصنف ${item.code}${input.description ? `: ${input.description}` : ""}`,
                  idempotencyKey: input.idempotencyKey,
                  lines: [
                    {
                      accountId: debitId,
                      debit: moneyString(amount),
                      credit: "0",
                      description: "تسوية جرد",
                    },
                    {
                      accountId: creditId,
                      debit: "0",
                      credit: moneyString(amount),
                      description: "تسوية جرد",
                    },
                  ],
                },
              );
              await client.query(
                "UPDATE stock_operations SET financial_document_id=$1 WHERE company_id=$2 AND id=$3",
                [financialDocumentId, companyId, operationId],
              );
            }
          }
          // Persist shelf and nearest expiry in the SAME transaction as the
          // inventory movement/journal. Never update the card on failed posting.
          if (input.nearestExpiryDate !== undefined || shelfName !== undefined || compositionNeedsLink) {
            const sets: string[] = [];
            const values: unknown[] = [];
            if (input.nearestExpiryDate !== undefined) {
              values.push(input.nearestExpiryDate);
              sets.push("nearest_expiry_date=$"+values.length);
            }
            if (shelfName !== undefined) {
              values.push(shelfName);
              sets.push("shelf=$"+values.length);
              values.push(input.shelfId);
              sets.push("shelf_id=$"+values.length);
            }
            if (compositionNeedsLink && input.compositionId !== undefined) {
              values.push(input.compositionId);
              sets.push("composition_id=$"+values.length);
            }
            values.push(companyId,input.itemId);
            await client.query(
              "UPDATE items SET "+sets.join(",")+
              ",revision=revision+1,updated_at=clock_timestamp()"+
              " WHERE company_id=$"+(values.length-1)+" AND id=$"+values.length,
              values,
            );
          }
          // Credit only real due-count settlements invoked from the designated
          // required-count workflow. No rewards for unrelated adjustments.
          if (eligibleForTask)
            await awardRequiredStockCount(client, companyId, operationId, input.itemId, user);
          return {
            created: true,
            operation: await auditStockOperation(
              client,
              companyId,
              user,
              operationId,
              {
                itemId: item.id,
                locationId: input.locationId,
                expiryDate: movementExpiryDate,
                nearestExpiryDate: input.nearestExpiryDate,
                shelfId: input.shelfId,
                quantitySmallest: current.toString(),
              },
            ),
          };
        },
      );
      res
        .status(result.created ? 201 : 200)
        .json({ operation: result.operation });
    }),
  );
  return router;
}

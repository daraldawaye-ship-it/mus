import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import {
  inventorySettingsSchema,
  stockTransferSchema,
  stockAdjustmentSchema,
  stockMovementKinds,
} from "../../../packages/contracts/src/inventory.ts";
import { documentDateSchema } from "../../../packages/contracts/src/finance.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { conflict, masterPage, mutateMaster } from "./services/masters.ts";
import {
  checkQuantum,
  moneyString,
  moneyUnits,
  quantum,
} from "./services/finance.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { postCommerceJournal } from "./services/commerce-ledger.ts";
import {
  applyStock,
  assertStockChronology,
  auditStockOperation,
  checkStockLocation,
  createStockOperation,
  findStockOperation,
  getInventorySettings,
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
  pooledQuantitySmallest: "v.quantity_smallest",
  pooledValueBase: "v.value_base",
};
const movementColumns = {
  id: "m.id",
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
        await readInventory(pool, req, (client, companyId) =>
          masterPage(
            client,
            req,
            companyId,
            stockBalanceSelect,
            stockBalanceFrom,
            "s",
            balanceColumns,
            ["i.code", "i.name", "l.name", "b.name"],
            stockBalanceDTO,
            {
              itemId: "id",
              locationId: "id",
              expiryDate: expiry === undefined ? [] : [expiry],
            },
            "itemCode:asc,locationName:asc,expiryDate:asc",
          ),
        ),
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
            "m.company_id=$1 AND (i.code ILIKE $2 OR i.name ILIKE $2 OR l.name ILIKE $2 OR b.name ILIKE $2 OR u.display_name ILIKE $2)";
          for (const key of [
            "itemId",
            "locationId",
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
          await assertStockChronology(
            client,
            companyId,
            input.itemId,
            input.documentDate,
          );
          if (item.hasExpiry && input.expiryDate === null)
            conflict("اختر تاريخ الدفعة التي جردتها لهذا الصنف");
          if (!item.hasExpiry && input.expiryDate !== null)
            conflict("الصنف لا يتتبع تاريخ انتهاء");
          const multiplier = stockUnitMultiplier(item, input.unit);
          const counted = BigInt(input.countedQuantity) * multiplier;
          const existing = await client.query(
            "SELECT quantity_smallest FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND location_id=$3 AND batch_key=$4 FOR UPDATE",
            [companyId, input.itemId, input.locationId, input.expiryDate ?? ""],
          );
          const current = existing.rows[0]
            ? BigInt(existing.rows[0].quantity_smallest)
            : 0n;
          if (current !== BigInt(input.expectedQuantitySmallest))
            conflict(
              "تغير رصيد الدفعة أثناء الجرد؛ أعد تحميل الرصيد وراجع الكمية المعدودة قبل الحفظ",
            );
          const delta = counted - current;
          checkQuantum(input.unitCostBase, settings.baseDecimalPlaces);
          const operationId = await createStockOperation(
            client,
            companyId,
            user,
            "adjustment",
            input,
          );
          if (delta !== 0n) {
            let cost: bigint | undefined;
            if (delta > 0n) {
              const divisor = multiplier * quantum(settings.baseDecimalPlaces),
                numerator = moneyUnits(input.unitCostBase) * delta;
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
              expiryDate: input.expiryDate,
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
                expiryDate: input.expiryDate,
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

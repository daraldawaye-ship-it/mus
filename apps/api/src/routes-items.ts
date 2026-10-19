import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import {
  convertItemQuantity,
  itemAgentSchema,
  itemAgentPatchSchema,
  itemCompositionSchema,
  itemCompositionPatchSchema,
  itemSchema,
  itemPatchSchema,
  itemConversionSchema,
  itemShelfPatchSchema,
  arabicShelfLetters,
} from "../../../packages/contracts/src/index.ts";
import { readItemStatistics } from "./services/item-statistics.ts";
import { readItemActivity } from "./services/item-activity.ts";
import { readItemPurchasePrices } from "./services/item-purchase-prices.ts";
import { readItemCompositionPeers } from "./services/item-composition-peers.ts";
import { canOrderItemsBySales, itemSaleTimesOrderSql } from "./services/item-sale-ranking.ts";
import {
  canReadItemCoverage,
  canReadItemStock,
  addItemCoverageToPage,
  itemCoverageJoin,
  itemCoverageSelect,
  itemCoverageRedactedSelect,
  readItemCoverage,
} from "./services/item-coverage.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import {
  itemAgentDTO,
  itemAgentSelect,
  itemCompositionDTO,
  itemCompositionSelect,
  itemShelfDTO,
  itemShelfSelect,
  itemDTO,
  itemSelect,
  itemFrom,
} from "./repositories/items.ts";
import { currencyDTO } from "./repositories/masters.ts";
import { audit } from "./services/audit.ts";
import {
  conflict,
  masterPage,
  masterRow,
  mutateMaster,
} from "./services/masters.ts";
import {
  checkItemReferences,
  itemFieldColumns,
  itemIdempotent,
  nextItemCode,
  readItems,
} from "./services/items.ts";

const agentColumns = {
  id: "a.id",
  name: "a.name",
  phone: "a.phone",
  address: "a.address",
  active: "a.active",
  createdAt: "a.created_at",
  updatedAt: "a.updated_at",
};
const itemColumns = {
  id: "i.id",
  code: "i.code",
  name: "i.name",
  englishName: "i.english_name",
  productForm: "i.product_form",
  barcode: "i.barcode",
  legacyId: "i.legacy_id",
  agentId: "i.agent_id",
  supplierAccountId: "i.supplier_account_id",
  compositionId: "i.composition_id",
  shelfId: "i.shelf_id",
  compositionArabicName: "f.arabic_name",
  agentName: "a.name",
  unit1Name: "i.unit1_name",
  unit2Name: "i.unit2_name",
  unit3Name: "i.unit3_name",
  factor2: "i.factor2",
  factor3: "i.factor3",
  defaultSaleUnit: "i.default_sale_unit",
  salePrice1: "i.sale_price1",
  salePrice2: "i.sale_price2",
  salePrice3: "i.sale_price3",
  purchasePrice: "i.purchase_price",
  commissionRate: "i.commission_rate",
  clearanceFrom: "i.clearance_from",
  clearanceTo: "i.clearance_to",
  purchaseFactor: "i.purchase_factor",
  currencyId: "i.currency_id",
  currencyCode: "c.code",
  reorderLimit: "i.reorder_limit",
  orderQuantity: "i.order_quantity",
  reserveQuantity: "i.reserve_quantity",
  searchKeys: "i.search_keys",
  orderStoppedUntil: "i.order_stopped_until",
  hasExpiry: "i.has_expiry",
  nearestExpiryDate: "i.nearest_expiry_date",
  active: "i.active",
  createdAt: "i.created_at",
  updatedAt: "i.updated_at",
};

const compositionImportRow = z.object({
  arabicName: z.string().trim().min(1).max(240),
  englishName: z.string().trim().min(1).max(240),
}).strict();
const compositionImportBatch = z.object({
  format: z.literal("tijara-compositions-v1"),
  items: z.array(compositionImportRow).min(1).max(80),
}).strict();
const compositionKey = (arabicName: string, englishName: string) =>
  JSON.stringify([arabicName.trim().toLowerCase(), englishName.trim().toLowerCase()]);

export function itemRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  const shelfColumns = {
    id: "s.id",
    code: "s.name",
    name: "s.name",
    groupLetter: "s.group_letter",
    groupOrder: "s.group_order",
    slotNumber: "s.slot_number",
    archived: "s.archived",
    vitrine: "s.vitrine",
    createdAt: "s.created_at",
    updatedAt: "s.updated_at",
  };
  router.get(
    `${base}/item-shelves`,
    handler(async (req,res) => {
      res.json(await readItems(pool,req,(client,companyId)=>
        masterPage(client,req,companyId,itemShelfSelect,
          "FROM item_shelves s","s",shelfColumns,
          ["s.name","s.group_letter"],itemShelfDTO,
          { groupLetter: arabicShelfLetters, archived: "boolean", vitrine: "boolean" },
          "groupOrder:asc,slotNumber:asc"),
      ));
    }),
  );
  router.get(
    `${base}/item-shelves/:id`,
    handler(async(req,res)=>{
      const rowId=id(req.params.id);
      res.json(await readItems(pool,req,async(client,companyId)=>({
        shelf:itemShelfDTO(await masterRow(client,itemShelfSelect,"s",companyId,rowId)),
      })));
    }),
  );
  router.patch(
    `${base}/item-shelves/:id`,
    handler(async(req,res)=>{
      const input=parse(itemShelfPatchSchema,req.body);
      const rowId=id(req.params.id);
      const shelf=await mutateMaster(pool,req,"items.manage",async(client,user,companyId)=>{
        const before=itemShelfDTO(await masterRow(client,itemShelfSelect,"s",companyId,rowId));
        if(before.revision!==input.revision)
          conflict("تم تعديل الرف بواسطة مستخدم آخر؛ أعد تحميل الكرت");
        const updated=await client.query(
          `UPDATE item_shelves SET archived=$1,vitrine=$2,revision=revision+1,
            updated_at=clock_timestamp()
            WHERE company_id=$3 AND id=$4 AND revision=$5 RETURNING *`,
          [input.archived,input.vitrine,companyId,rowId,input.revision],
        );
        if(!updated.rows[0])conflict("تم تعديل الرف بواسطة مستخدم آخر؛ أعد تحميل الكرت");
        const next=itemShelfDTO(updated.rows[0]);
        await audit(client,user,"itemShelf.update","itemShelf",rowId,before,next,companyId);
        return next;
      });
      res.json({shelf});
    }),
  );
  const compositionColumns = {
    id: "f.id",
    arabicName: "f.arabic_name",
    englishName: "f.english_name",
    productForm: "f.product_form",
    active: "f.active",
    identicalAlternative: "f.identical_alternative",
    nonInterchangeable: "f.non_interchangeable",
    createdAt: "f.created_at",
    updatedAt: "f.updated_at",
  };
  router.get(
    `${base}/item-compositions`,
    handler(async (req, res) => {
      res.json(await readItems(pool, req, (client, companyId) =>
        masterPage(client, req, companyId, itemCompositionSelect,
          "FROM item_compositions f", "f", compositionColumns,
          ["f.arabic_name", "f.english_name", "f.description"],
          itemCompositionDTO, { active: "boolean" }, "arabicName:asc"),
      ));
    }),
  );
  // Bulk import is additive: no item association is changed, and importing
  // the same file twice skips names already present in this company.
  router.post(
    `${base}/item-compositions/import-batch`,
    handler(async (req, res) => {
      const input = parse(compositionImportBatch, req.body);
      const result = await mutateMaster(pool, req, "items.manage", async (client, user, companyId) => {
        // Serialize imports per company, including retries from multiple tabs.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('item-composition-import'),$1::integer)",
          [companyId],
        );
        const rows = await client.query(
          "SELECT arabic_name,english_name FROM item_compositions WHERE company_id=$1",
          [companyId],
        );
        const present = new Set<string>(rows.rows.map(
          (row) => compositionKey(row.arabic_name as string, row.english_name as string),
        ));
        const fresh: z.output<typeof compositionImportRow>[] = [];
        let skipped = 0;
        for (const row of input.items) {
          const key = compositionKey(row.arabicName, row.englishName);
          if (present.has(key)) { skipped++; continue; }
          present.add(key);
          fresh.push(row);
        }
        if (!fresh.length) return { created: 0, skipped };
        const bindings: unknown[] = [];
        const values: string[] = [];
        for (const row of fresh) {
          const entries: unknown[] = [
            companyId, row.arabicName, row.englishName, "",
            true, false, false, user.id, randomUUID(),
            JSON.stringify({
              arabicName: row.arabicName, englishName: row.englishName,
              description: "", active: true,
              identicalAlternative: false, nonInterchangeable: false,
            }),
          ];
          const start = bindings.length;
          bindings.push(...entries);
          values.push("(" + entries.map((_, i) => "$" + (start + i + 1)).join(",") + ")");
        }
        const inserted = await client.query(
          `INSERT INTO item_compositions
           (company_id,arabic_name,english_name,description,active,
            identical_alternative,non_interchangeable,created_by,idempotency_key,creation_payload)
           VALUES ${values.join(",")} RETURNING id`,
          bindings,
        );
        const ids: number[] = inserted.rows.map((row) => row.id as number);
        await client.query(
          `INSERT INTO audit_events
             (actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
           SELECT $2,$3,'company',$1,'itemComposition.create','itemComposition',
                  f.id,NULL,to_jsonb(f)
           FROM item_compositions f WHERE f.company_id=$1 AND f.id=ANY($4::integer[])`,
          [companyId,user.id,user.displayName,ids],
        );
        return { created: ids.length, skipped };
      });
      res.json(result);
    }),
  );
  router.post(
    `${base}/item-compositions`,
    handler(async (req, res) => {
      const input = parse(itemCompositionSchema, req.body);
      const result = await mutateMaster(pool, req, "items.manage", async (client, user, companyId) => {
        const existing = await itemIdempotent(
          client, "item_compositions", companyId, input.idempotencyKey, input,
        );
        if (existing) return {
          composition: itemCompositionDTO(await masterRow(
            client, itemCompositionSelect, "f", companyId, existing.id,
          )),
          created: false,
        };
        const added = await client.query(
          `INSERT INTO item_compositions
          (company_id,arabic_name,english_name,description,sale_notes,product_form,active,
           identical_alternative,non_interchangeable,created_by,idempotency_key,creation_payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [companyId,input.arabicName,input.englishName,input.description,input.saleNotes,input.productForm,input.active,
           input.identicalAlternative,input.nonInterchangeable,user.id,input.idempotencyKey,
           JSON.stringify(input)],
        );
        const composition = itemCompositionDTO(await masterRow(
          client, itemCompositionSelect, "f", companyId, added.rows[0].id,
        ));
        await audit(client,user,"itemComposition.create","itemComposition",
          composition.id,null,composition,companyId);
        return { composition, created: true };
      });
      res.status(result.created ? 201 : 200).json({ composition: result.composition });
    }),
  );
  router.get(
    `${base}/item-compositions/:id`,
    handler(async (req, res) => {
      const compositionId = id(req.params.id);
      res.json(await readItems(pool,req,async (client,companyId) => ({
        composition: itemCompositionDTO(await masterRow(
          client,itemCompositionSelect,"f",companyId,compositionId,
        )),
      })));
    }),
  );
  router.patch(
    `${base}/item-compositions/:id`,
    handler(async (req,res) => {
      const input = parse(itemCompositionPatchSchema,req.body);
      const compositionId = id(req.params.id);
      const composition = await mutateMaster(pool,req,"items.manage",async (client,user,companyId)=>{
        const before = itemCompositionDTO(await masterRow(
          client,itemCompositionSelect,"f",companyId,compositionId,
        ));
        if (before.revision !== input.revision)
          conflict("تم تعديل التركيب بواسطة مستخدم آخر؛ حمّل النسخة الحالية قبل الحفظ");
        await client.query(
          `UPDATE item_compositions
          SET arabic_name=$1,english_name=$2,description=$3,sale_notes=$4,product_form=$5,active=$6,
              identical_alternative=$7,non_interchangeable=$8,
              revision=revision+1,updated_at=clock_timestamp()
          WHERE company_id=$9 AND id=$10`,
          [input.arabicName,input.englishName,input.description,input.saleNotes,input.productForm,input.active,
            input.identicalAlternative,input.nonInterchangeable,companyId,compositionId],
        );
        const next = itemCompositionDTO(await masterRow(
          client,itemCompositionSelect,"f",companyId,compositionId,
        ));
        await audit(client,user,"itemComposition.update","itemComposition",
          compositionId,before,next,companyId);
        return next;
      });
      res.json({ composition });
    }),
  );

  router.get(
    `${base}/item-agents`,
    handler(async (req, res) => {
      res.json(
        await readItems(pool, req, (client, companyId) =>
          masterPage(
            client,
            req,
            companyId,
            itemAgentSelect,
            "FROM item_agents a",
            "a",
            agentColumns,
            ["a.name", "a.phone", "a.address", "a.notes"],
            itemAgentDTO,
            { active: "boolean" },
            "name:asc",
          ),
        ),
      );
    }),
  );
  router.post(
    `${base}/item-agents`,
    handler(async (req, res) => {
      const input = parse(itemAgentSchema, req.body);
      const result = await mutateMaster(
        pool,
        req,
        "items.manage",
        async (client, user, companyId) => {
          const previous = await itemIdempotent(
            client,
            "item_agents",
            companyId,
            input.idempotencyKey,
            input,
          );
          if (previous)
            return {
              agent: itemAgentDTO(
                await masterRow(
                  client,
                  itemAgentSelect,
                  "a",
                  companyId,
                  previous.id,
                ),
              ),
              created: false,
            };
          const added = await client.query(
            "INSERT INTO item_agents(company_id,name,phone,address,notes,active,created_by,idempotency_key,creation_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            [
              companyId,
              input.name,
              input.phone,
              input.address,
              input.notes,
              input.active,
              user.id,
              input.idempotencyKey,
              JSON.stringify(input),
            ],
          );
          const agent = itemAgentDTO(
            await masterRow(
              client,
              itemAgentSelect,
              "a",
              companyId,
              added.rows[0].id,
            ),
          );
          await audit(
            client,
            user,
            "itemAgent.create",
            "itemAgent",
            agent.id,
            null,
            agent,
            companyId,
          );
          return { agent, created: true };
        },
      );
      res.status(result.created ? 201 : 200).json({ agent: result.agent });
    }),
  );
  router.get(
    `${base}/item-agents/:id`,
    handler(async (req, res) => {
      const rowId = id(req.params.id);
      res.json(
        await readItems(pool, req, async (client, companyId) => ({
          agent: itemAgentDTO(
            await masterRow(client, itemAgentSelect, "a", companyId, rowId),
          ),
        })),
      );
    }),
  );
  router.patch(
    `${base}/item-agents/:id`,
    handler(async (req, res) => {
      const input = parse(itemAgentPatchSchema, req.body),
        rowId = id(req.params.id);
      const agent = await mutateMaster(
        pool,
        req,
        "items.manage",
        async (client, user, companyId) => {
          const before = itemAgentDTO(
            await masterRow(client, itemAgentSelect, "a", companyId, rowId),
          );
          if (input.revision !== before.revision)
            conflict(
              "تم تعديل الوكيل بواسطة مستخدم آخر؛ أعد تحميل السجل قبل الحفظ",
            );
          await client.query(
            "UPDATE item_agents SET name=$1,phone=$2,address=$3,notes=$4,active=$5,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$6 AND id=$7",
            [
              input.name,
              input.phone,
              input.address,
              input.notes,
              input.active,
              companyId,
              rowId,
            ],
          );
          const next = itemAgentDTO(
            await masterRow(client, itemAgentSelect, "a", companyId, rowId),
          );
          await audit(
            client,
            user,
            "itemAgent.update",
            "itemAgent",
            rowId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ agent });
    }),
  );

  router.get(
    `${base}/items`,
    handler(async (req, res) => {
      res.json(
        await readItems(pool, req, async (client, companyId) => {
          const canRank = await canOrderItemsBySales(client,actor(req),companyId);
          const canViewCoverage = await canReadItemCoverage(client, actor(req), companyId);
          const canViewStock = await canReadItemStock(client, actor(req), companyId);
          // masterPage validates the complete sort expression. This check only
          // chooses whether coverage must be available before pagination.
          const coverageSort = canViewCoverage && typeof req.query.sort === "string"
            && req.query.sort.split(",").some(sort =>
              ["approximateCoverageDays", "coverageAfterReserveDays"].includes(sort.split(":")[0]),
            );
          const coverageJoin = coverageSort ? itemCoverageJoin : "";
          const stockJoin = canViewStock
            ? " LEFT JOIN item_statistics list_stock ON list_stock.company_id=i.company_id AND list_stock.item_id=i.id"
            : "";
          const listFrom = itemFrom + stockJoin + coverageJoin;
          const stockSelect = canViewStock
            ? ",COALESCE(list_stock.stock_total,0)::text AS available_smallest"
            : ",NULL::text AS available_smallest";
          const stockOrder = canViewStock
            ? "COALESCE(list_stock.stock_total,0)::numeric / (i.factor2::numeric * i.factor3)"
            : "NULL::numeric";
          const result = await masterPage(
            client,
            req,
            companyId,
            itemSelect.replace(itemFrom, `${stockSelect}${coverageSort ? itemCoverageSelect : itemCoverageRedactedSelect} ${listFrom}`),
            listFrom,
            "i",
            {
              ...itemColumns,
              saleTimes: canRank ? itemSaleTimesOrderSql : "0::bigint",
              availableUnit1: stockOrder,
              approximateCoverageDays: coverageSort ? "coverage.approximate_coverage_days" : "NULL::numeric",
              coverageAfterReserveDays: coverageSort ? "coverage.coverage_after_reserve_days" : "NULL::numeric",
            },
            [
              "i.code",
              "i.name",
              "i.english_name",
              "i.barcode",
              "i.legacy_id",
              "i.search_keys",
              "a.name",
              "f.arabic_name",
              "f.english_name",
            ],
            itemDTO,
            {
              active: "boolean",
              hasExpiry: "boolean",
              agentId: "id",
              compositionId: "id",
              shelfId: "id",
              currencyId: "id",
            },
            "saleTimes:desc,code:asc",
            "item",
            ["i.code","i.barcode"],
          );
          if (canViewCoverage && !coverageSort)
            result.items = await addItemCoverageToPage(client, companyId, result.items);
          return result;
        }),
      );
    }),
  );
  router.post(
    `${base}/items`,
    handler(async (req, res) => {
      const input = parse(itemSchema, req.body);
      const result = await mutateMaster(
        pool,
        req,
        "items.manage",
        async (client, user, companyId) => {
          const previous = await itemIdempotent(
            client,
            "items",
            companyId,
            input.idempotencyKey,
            input,
          );
          if (previous)
            return {
              item: itemDTO(
                await masterRow(
                  client,
                  itemSelect,
                  "i",
                  companyId,
                  previous.id,
                ),
              ),
              created: false,
            };
          await checkItemReferences(client, companyId, input);
          const code = await nextItemCode(client, companyId);
          const values = [
            companyId,
            code,
            ...itemFieldColumns.map(([field]) => input[field]),
            user.id,
            input.idempotencyKey,
            JSON.stringify(input),
          ];
          const columns = [
            "company_id",
            "code",
            ...itemFieldColumns.map(([, column]) => column),
            "created_by",
            "idempotency_key",
            "creation_payload",
          ];
          const added = await client.query(
            `INSERT INTO items(${columns.join(",")}) VALUES(${values.map((_, position) => `$${position + 1}`).join(",")}) RETURNING id`,
            values,
          );
          // Persist additional option defaults only on the first creation.
          // Native item flags remain authoritative on the items table.
          await client.query(
            `INSERT INTO option_values(company_id,definition_id,record_kind,item_id,value,created_by,updated_by)
             SELECT company_id,id,'item',$2,default_value,$3,$3
             FROM option_definitions
             WHERE company_id=$1 AND record_kind='item' AND active=true
               AND native_binding IS NULL AND default_value <> 'null'::jsonb`,
            [companyId, added.rows[0].id, user.id],
          );
          const item = itemDTO(
            await masterRow(
              client,
              itemSelect,
              "i",
              companyId,
              added.rows[0].id,
            ),
          );
          await audit(
            client,
            user,
            "item.create",
            "item",
            item.id,
            null,
            item,
            companyId,
          );
          return { item, created: true };
        },
      );
      res.status(result.created ? 201 : 200).json({ item: result.item });
    }),
  );
  router.get(
    `${base}/items/:id/coverage`,
    handler(async (req, res) => {
      const itemId = id(req.params.id);
      res.json(await readItems(pool, req, async (client, companyId) => ({
        coverage: await readItemCoverage(client, actor(req), companyId, itemId),
      })));
    }),
  );
  router.get(
    `${base}/items/:id/composition-peers`,
    handler(async (req,res)=>{
      const itemId=id(req.params.id);
      const raw=req.query.page;
      const page=raw===undefined?1:typeof raw==="string"&&/^[1-9][0-9]{0,5}$/.test(raw)?Number(raw):0;
      if(page<1||page>100000)
        throw new HttpError(400,"invalid_page","رقم صفحة الأصناف المرتبطة غير صالح");
      res.json(await readItems(pool,req,async(client,companyId)=>({
        peers:await readItemCompositionPeers(client,actor(req),companyId,itemId,page),
      })));
    }),
  );
  router.get(
    `${base}/items/:id/purchase-price-statistics`,
    handler(async (req,res)=>{
      const itemId=id(req.params.id);
      res.json(await readItems(pool,req,async(client,companyId)=>({
        statistics:await readItemPurchasePrices(client,actor(req),companyId,itemId),
      })));
    }),
  );
  router.get(
    `${base}/items/:id/activity`,
    handler(async (req,res)=>{
      const rowId=id(req.params.id);
      res.json(await readItems(pool,req,async (client,companyId)=>({
        activity:await readItemActivity(client,actor(req),companyId,rowId),
      })));
    }),
  );
  router.get(
    `${base}/items/:id/statistics`,
    handler(async (req, res) => {
      const rowId = id(req.params.id);
      res.json(
        await readItems(pool, req, async (client, companyId) => ({
          statistics: await readItemStatistics(
            client,
            actor(req),
            companyId,
            rowId,
          ),
        })),
      );
    }),
  );
  router.get(
    `${base}/items/:id`,
    handler(async (req, res) => {
      const rowId = id(req.params.id);
      res.json(
        await readItems(pool, req, async (client, companyId) => ({
          item: itemDTO(
            await masterRow(client, itemSelect, "i", companyId, rowId),
          ),
        })),
      );
    }),
  );
  router.patch(
    `${base}/items/:id`,
    handler(async (req, res) => {
      const input = parse(itemPatchSchema, req.body),
        rowId = id(req.params.id);
      const item = await mutateMaster(
        pool,
        req,
        "items.manage",
        async (client, user, companyId) => {
          const before = itemDTO(
            await masterRow(client, itemSelect, "i", companyId, rowId),
          );
          if (input.revision !== before.revision)
            conflict(
              "تم تعديل الصنف بواسطة مستخدم آخر؛ أعد تحميل السجل قبل الحفظ",
            );
          // An archived item must have no remaining stock in any location.
          // Include negative balances and opposing showroom/warehouse balances:
          // a zero company total alone does not mean the item is empty.
          if (before.active && !input.active) {
            const balance = await client.query(
              `SELECT 1 FROM item_statistics WHERE company_id=$1 AND item_id=$2
               AND (stock_total<>0 OR stock_showroom<>0 OR stock_warehouse<>0)
               FOR UPDATE`,
              [companyId, rowId],
            );
            if (balance.rowCount)
              conflict("لا يمكن أرشفة صنف له كمية في المخزون؛ صفّر رصيد جميع المواقع بالتسوية أولًا");
          }
          const unitFields = [
            "unit1Name",
            "unit2Name",
            "unit3Name",
            "factor2",
            "factor3",
            "hasExpiry",
          ] as const;
          if (unitFields.some((field) => input[field] !== before[field])) {
            const history = await client.query(
              "SELECT 1 FROM stock_movements WHERE company_id=$1 AND item_id=$2 LIMIT 1",
              [companyId, rowId],
            );
            if (history.rowCount)
              conflict(
                "لا يمكن تغيير الوحدات أو عواملها أو تتبع الانتهاء بعد وجود حركات للصنف؛ أنشئ صنفًا جديدًا للبنية المختلفة",
              );
          }
          const fields = {
            ...input,
            legacyId: input.legacyId ?? before.legacyId,
            defaultSaleUnit: input.defaultSaleUnit ?? before.defaultSaleUnit,
            compositionId: input.compositionId === undefined ? before.compositionId : input.compositionId,
            shelfId: input.shelfId === undefined ? before.shelfId : input.shelfId,
            reserveQuantity: input.reserveQuantity ?? before.reserveQuantity,
            supplierAccountId: input.supplierAccountId === undefined ? before.supplierAccountId : input.supplierAccountId,
            nearestExpiryDate: input.nearestExpiryDate === undefined ? before.nearestExpiryDate : input.nearestExpiryDate,
          };
          await checkItemReferences(client, companyId, fields, before);
          const values: unknown[] = itemFieldColumns.map(
            ([field]) => fields[field],
          );
          values.push(companyId, rowId);
          await client.query(
            `UPDATE items SET ${itemFieldColumns.map(([, column], position) => `${column}=$${position + 1}`).join(",")},supplier_inferred=${input.supplierAccountId === undefined ? "supplier_inferred" : "false"},revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$${values.length - 1} AND id=$${values.length}`,
            values,
          );
          const next = itemDTO(
            await masterRow(client, itemSelect, "i", companyId, rowId),
          );
          await audit(
            client,
            user,
            "item.update",
            "item",
            rowId,
            before,
            next,
            companyId,
          );
          // Keep the complete immutable audit snapshot above for existing
          // consumers, then provide an independently readable event for every
          // modified card field, including its previous and next values.
          const fieldLabels: Record<string, string> = {
            name: "اسم الصنف", englishName: "الاسم بالإنجليزية",
            shelf: "الرف الحالي", shelfId: "ربط الرف",
            imageId: "الصورة", barcode: "الباركود",
            legacyId: "المعرف في النظام السابق", agentId: "وكيل الصنف",
            supplierAccountId: "مورد الصنف", compositionId: "التركيب",
            unit1Name: "الوحدة الأولى", unit2Name: "الوحدة الثانية",
            unit3Name: "الوحدة الثالثة", factor2: "عدد الوحدة الثانية",
            factor3: "عدد الوحدة الثالثة", defaultSaleUnit: "وحدة البيع الافتراضية",
            salePrice1: "سعر بيع الوحدة الأولى", salePrice2: "سعر بيع الوحدة الثانية",
            salePrice3: "سعر بيع الوحدة الثالثة", purchasePrice: "سعر الشراء",
            purchaseFactor: "عامل وحدة الشراء", currencyId: "عملة الأسعار",
            reorderLimit: "حد الطلب", orderQuantity: "كمية الطلب",
            reserveQuantity: "الكمية الاحتياطية", searchKeys: "مفاتيح البحث",
            purchaseNotes: "ملاحظات الشراء", orderStoppedUntil: "توقف الطلب حتى",
            hasExpiry: "يتطلب تاريخ انتهاء", nearestExpiryDate: "أقرب تاريخ انتهاء",
            commissionRate: "نسبة العمولة", clearanceFrom: "بداية التصريف",
            clearanceTo: "نهاية التصريف",
            settlementApprovalDate: "تاريخ اعتماد التسوية",
            settlementDisplayDate: "تاريخ عرض التسوية", active: "حالة الأرشفة",
          };
          const oldValues = before as unknown as Record<string, unknown>;
          const newValues = next as unknown as Record<string, unknown>;
          for (const [field] of itemFieldColumns) {
            if (JSON.stringify(oldValues[field]) === JSON.stringify(newValues[field]))
              continue;
            const label = fieldLabels[field] ?? field;
            await audit(
              client, user, "item.field.update", "item", rowId,
              { field, label, value: oldValues[field] ?? null },
              { field, label, value: newValues[field] ?? null },
              companyId,
            );
          }
          return next;
        },
      );
      res.json({ item });
    }),
  );
  router.get(
    `${base}/items/:id/conversion`,
    handler(async (req, res) => {
      const rowId = id(req.params.id);
      const unit =
        typeof req.query.unit === "string" &&
        ["1", "2", "3"].includes(req.query.unit)
          ? Number(req.query.unit)
          : req.query.unit;
      const input = parse(itemConversionSchema, {
        quantity: req.query.quantity,
        unit,
      });
      res.json(
        await readItems(pool, req, async (client, companyId) => {
          const item = itemDTO(
            await masterRow(client, itemSelect, "i", companyId, rowId),
          );
          if (
            (input.unit === 2 && item.factor2 === 1) ||
            (input.unit === 3 && item.factor3 === 1)
          )
            throw new HttpError(
              400,
              "inactive_unit",
              "هذا المستوى من الوحدة غير مفعل للصنف",
            );
          return { conversion: convertItemQuantity(input, item) };
        }),
      );
    }),
  );
  router.get(
    `${base}/item-options`,
    handler(async (req, res) => {
      res.json(
        await readItems(pool, req, async (client, companyId) => {
          if (req.query.type === "shelves")
            return masterPage(client,req,companyId,
              "SELECT s.* FROM item_shelves s",
              "FROM item_shelves s","s",shelfColumns,
              ["s.name","s.group_letter"],itemShelfDTO,
              { archived:"boolean", groupLetter:arabicShelfLetters },
              "groupOrder:asc,slotNumber:asc");
          if (req.query.type === "compositions")
            return masterPage(
              client,req,companyId,
              "SELECT f.* FROM (SELECT * FROM item_compositions WHERE active) f",
              "FROM (SELECT * FROM item_compositions WHERE active) f","f",
              compositionColumns,
              ["f.arabic_name","f.english_name","f.description"],
              itemCompositionDTO,{active:"boolean"},"arabicName:asc",
            );
          if (req.query.type === "agents")
            return masterPage(
              client,
              req,
              companyId,
              "SELECT a.* FROM (SELECT * FROM item_agents WHERE active) a",
              "FROM (SELECT * FROM item_agents WHERE active) a",
              "a",
              { ...agentColumns, code: "a.name" },
              ["a.name", "a.phone", "a.address"],
              itemAgentDTO,
              { active: "boolean" },
              "name:asc",
            );
          if (req.query.type === "suppliers") {
            await companyAccess(client, actor(req), companyId, "items.manage");
            return masterPage(
              client,req,companyId,
              "SELECT a.* FROM (SELECT id,company_id,code,name,category,cash_or_bank AS \"cashOrBank\",active FROM accounts WHERE kind='posting' AND category IN ('asset','liability') AND NOT cash_or_bank) a",
              "FROM (SELECT id,company_id,code,name,category,cash_or_bank AS \"cashOrBank\",active FROM accounts WHERE kind='posting' AND category IN ('asset','liability') AND NOT cash_or_bank) a",
              "a",
              { id:"a.id",code:"a.code",name:"a.name",active:"a.active" },
              ["a.code","a.name"],
              row=>({id:row.id,code:row.code,name:row.name,active:row.active,category:row.category,cashOrBank:row.cashOrBank}),
              { active:"boolean" },"name:asc",
            );
          }
          if (req.query.type === "currencies")
            return masterPage(
              client,
              req,
              companyId,
              "SELECT c.* FROM (SELECT * FROM company_currencies WHERE active) c",
              "FROM (SELECT * FROM company_currencies WHERE active) c",
              "c",
              {
                id: "c.id",
                code: "c.code",
                name: "c.name",
                decimalPlaces: "c.decimal_places",
                active: "c.active",
              },
              ["c.code", "c.name"],
              currencyDTO,
              { active: "boolean" },
              "code:asc",
            );
          missing("نوع خيارات الصنف غير موجود");
        }),
      );
    }),
  );
  return router;
}

/** Schemas reused by the generated MCP operation catalog. */
export const mcpBodySchemas = { compositionImportBatch };

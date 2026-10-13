import { Router } from "express";
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
} from "../../../packages/contracts/src/index.ts";
import { readItemStatistics } from "./services/item-statistics.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError, missing } from "./errors.ts";
import {
  itemAgentDTO,
  itemAgentSelect,
  itemCompositionDTO,
  itemCompositionSelect,
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
  barcode: "i.barcode",
  legacyId: "i.legacy_id",
  agentId: "i.agent_id",
  compositionId: "i.composition_id",
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
  searchKeys: "i.search_keys",
  orderStoppedUntil: "i.order_stopped_until",
  hasExpiry: "i.has_expiry",
  active: "i.active",
  createdAt: "i.created_at",
  updatedAt: "i.updated_at",
};

export function itemRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  const compositionColumns = {
    id: "f.id",
    arabicName: "f.arabic_name",
    englishName: "f.english_name",
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
          (company_id,arabic_name,english_name,description,active,
           identical_alternative,non_interchangeable,created_by,idempotency_key,creation_payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [companyId,input.arabicName,input.englishName,input.description,input.active,
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
          SET arabic_name=$1,english_name=$2,description=$3,active=$4,
              identical_alternative=$5,non_interchangeable=$6,
              revision=revision+1,updated_at=clock_timestamp()
          WHERE company_id=$7 AND id=$8`,
          [input.arabicName,input.englishName,input.description,input.active,
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
        await readItems(pool, req, (client, companyId) =>
          masterPage(
            client,
            req,
            companyId,
            itemSelect,
            itemFrom,
            "i",
            itemColumns,
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
              currencyId: "id",
            },
            "code:asc",
            "item",
          ),
        ),
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
          };
          await checkItemReferences(client, companyId, fields, before);
          const values: unknown[] = itemFieldColumns.map(
            ([field]) => fields[field],
          );
          values.push(companyId, rowId);
          await client.query(
            `UPDATE items SET ${itemFieldColumns.map(([, column], position) => `${column}=$${position + 1}`).join(",")},revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$${values.length - 1} AND id=$${values.length}`,
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

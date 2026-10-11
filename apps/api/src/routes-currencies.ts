import { Router } from "express";
import type { Pool } from "pg";
import {
  currenciesInitializeSchema,
  currencyPatchSchema,
  currencySchema,
  effectiveAtSchema,
  exchangeRatePatchSchema,
  exchangeRateSchema,
  financeSettingsSchema,
  type CompanyCurrency,
  type FinanceSettings,
} from "../../../packages/contracts/src/index.ts";
import type { Database } from "./db.ts";
import { HttpError } from "./errors.ts";
import { handler, id, parse } from "./http.ts";
import {
  currencyDTO,
  currencySelect,
  exchangeRateDTO,
  exchangeRateSelect,
  financeSettingsDTO,
  settingsSelect,
} from "./repositories/masters.ts";
import { audit } from "./services/audit.ts";
import {
  conflict,
  masterPage,
  masterRow,
  mutateMaster,
  readMaster,
} from "./services/masters.ts";

const currencyColumns = {
  id: "c.id",
  code: "c.code",
  name: "c.name",
  decimalPlaces: "c.decimal_places",
  active: "c.active",
  createdAt: "c.created_at",
};
const rateFrom =
  "FROM exchange_rates r JOIN company_currencies c ON c.company_id=r.company_id AND c.id=r.currency_id JOIN company_currencies b ON b.company_id=r.company_id AND b.id=r.base_currency_id";
const rateColumns = {
  id: "r.id",
  currencyId: "r.currency_id",
  currencyCode: "c.code",
  baseCurrencyId: "r.base_currency_id",
  baseCurrencyCode: "b.code",
  rate: "r.rate",
  effectiveAt: "r.effective_at",
  source: "r.source",
  active: "r.active",
  createdAt: "r.created_at",
};

async function settings(
  db: Database,
  companyId: number,
): Promise<FinanceSettings | null> {
  const result = await db.query(`${settingsSelect} WHERE s.company_id=$1`, [
    companyId,
  ]);
  return result.rows[0] ? financeSettingsDTO(result.rows[0]) : null;
}
async function requireSettings(
  db: Database,
  companyId: number,
): Promise<FinanceSettings> {
  const value = await settings(db, companyId);
  if (!value) conflict("اختر العملة الأساسية أولًا");
  return value;
}
async function currencyReference(
  db: Database,
  companyId: number,
  currencyId: number,
): Promise<CompanyCurrency> {
  const result = await db.query(
    `${currencySelect} WHERE c.company_id=$1 AND c.id=$2`,
    [companyId, currencyId],
  );
  if (!result.rows[0]) conflict("العملة يجب أن تكون من الشركة نفسها");
  return currencyDTO(result.rows[0]);
}

export function currencyRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  router.get(
    `${base}/currencies`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      res.json(
        await masterPage(
          pool,
          req,
          companyId,
          currencySelect,
          "FROM company_currencies c",
          "c",
          currencyColumns,
          ["c.code", "c.name"],
          currencyDTO,
          { active: "boolean" },
          "code:asc",
        ),
      );
    }),
  );
  router.post(
    `${base}/currencies`,
    handler(async (req, res) => {
      const input = parse(currencySchema, req.body);
      const currency = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          const result = await client.query(
            "INSERT INTO company_currencies(company_id,code,name,decimal_places,active,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              companyId,
              input.code,
              input.name,
              input.decimalPlaces,
              input.active,
              user.id,
            ],
          );
          const next = currencyDTO(result.rows[0]);
          await audit(
            client,
            user,
            "currency.create",
            "currency",
            next.id,
            null,
            next,
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ currency });
    }),
  );
  router.post(
    `${base}/currencies/initialize`,
    handler(async (req, res) => {
      const input = parse(currenciesInitializeSchema, req.body);
      const value = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          if (await settings(client, companyId))
            conflict(
              "تم اختيار العملة الأساسية بالفعل؛ أضف العملات أو عدّل الإعدادات مباشرة",
            );
          const existing = await client.query(
            `${currencySelect} WHERE c.company_id=$1 ORDER BY c.id`,
            [companyId],
          );
          const before = {
            currencies: existing.rows.map(currencyDTO),
            settings: null,
          };
          // Initialization completes the suggested catalog while preserving each existing identity and precision.
          for (const [code, name] of [
            ["YER", "ريال يمني"],
            ["SAR", "ريال سعودي"],
            ["USD", "دولار أمريكي"],
          ] as const) {
            await client.query(
              "INSERT INTO company_currencies(company_id,code,name,decimal_places,created_by) VALUES($1,$2,$3,2,$4) ON CONFLICT(company_id,code) DO NOTHING",
              [companyId, code, name, user.id],
            );
          }
          const result = await client.query(
            `${currencySelect} WHERE c.company_id=$1 ORDER BY c.id`,
            [companyId],
          );
          const currencies = result.rows.map(currencyDTO);
          const baseCurrency = currencies.find(
            (currency) => currency.code === input.baseCurrency,
          )!;
          if (!baseCurrency.active)
            conflict("فعّل العملة الأساسية المختارة قبل التهيئة");
          await client.query(
            "INSERT INTO finance_settings(company_id,base_currency_id) VALUES($1,$2)",
            [companyId, baseCurrency.id],
          );
          const next = await requireSettings(client, companyId);
          await audit(
            client,
            user,
            "currencies.initialize",
            "financeSettings",
            companyId,
            before,
            { currencies, settings: next },
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ settings: value });
    }),
  );
  router.get(
    `${base}/currencies/:id`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      res.json({
        currency: currencyDTO(
          await masterRow(
            pool,
            currencySelect,
            "c",
            companyId,
            id(req.params.id),
          ),
        ),
      });
    }),
  );
  router.patch(
    `${base}/currencies/:id`,
    handler(async (req, res) => {
      const input = parse(currencyPatchSchema, req.body),
        currencyId = id(req.params.id);
      const currency = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          const before = currencyDTO(
            await masterRow(client, currencySelect, "c", companyId, currencyId),
          );
          if (
            input.active === false &&
            (await settings(client, companyId))?.baseCurrencyId === currencyId
          )
            conflict("لا يمكن إيقاف العملة الأساسية");
          const result = await client.query(
            "UPDATE company_currencies SET name=$1,active=$2 WHERE company_id=$3 AND id=$4 RETURNING *",
            [
              input.name ?? before.name,
              input.active ?? before.active,
              companyId,
              currencyId,
            ],
          );
          const next = currencyDTO(result.rows[0]);
          await audit(
            client,
            user,
            "currency.update",
            "currency",
            currencyId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ currency });
    }),
  );
  router.get(
    `${base}/finance-settings`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      res.json({ settings: await settings(pool, companyId) });
    }),
  );
  router.patch(
    `${base}/finance-settings`,
    handler(async (req, res) => {
      const input = parse(financeSettingsSchema, req.body);
      const value = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          const before = await settings(client, companyId);
          const currency = await currencyReference(
            client,
            companyId,
            input.baseCurrencyId,
          );
          if (!currency.active) conflict("العملة الأساسية يجب أن تكون فعالة");
          if (before?.baseCurrencyId !== input.baseCurrencyId) {
            const history = await client.query(
              "SELECT 1 FROM exchange_rates WHERE company_id=$1 LIMIT 1",
              [companyId],
            );
            if (history.rowCount)
              conflict(
                "لا يمكن تغيير العملة الأساسية بعد تسجيل تاريخ أسعار الصرف",
              );
          }
          await client.query(
            "INSERT INTO finance_settings(company_id,base_currency_id) VALUES($1,$2) ON CONFLICT(company_id) DO UPDATE SET base_currency_id=excluded.base_currency_id",
            [companyId, input.baseCurrencyId],
          );
          const next = await requireSettings(client, companyId);
          await audit(
            client,
            user,
            "financeSettings.update",
            "financeSettings",
            companyId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ settings: value });
    }),
  );
  router.get(
    `${base}/exchange-rates`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      res.json(
        await masterPage(
          pool,
          req,
          companyId,
          exchangeRateSelect,
          rateFrom,
          "r",
          rateColumns,
          ["c.code", "c.name", "b.code", "r.source"],
          exchangeRateDTO,
          { currencyId: "id", active: "boolean" },
          "effectiveAt:desc",
        ),
      );
    }),
  );
  router.post(
    `${base}/exchange-rates`,
    handler(async (req, res) => {
      const input = parse(exchangeRateSchema, req.body);
      const exchangeRate = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          const value = await requireSettings(client, companyId);
          const currency = await currencyReference(
            client,
            companyId,
            input.currencyId,
          );
          if (!currency.active) conflict("اختر عملة فعالة لتسجيل سعر الصرف");
          if (currency.id === value.baseCurrencyId)
            throw new HttpError(
              400,
              "base_currency_rate",
              "سعر العملة الأساسية هو 1 ولا يُسجّل كسعر صرف",
            );
          const result = await client.query(
            "INSERT INTO exchange_rates(company_id,currency_id,base_currency_id,rate,effective_at,source,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [
              companyId,
              input.currencyId,
              value.baseCurrencyId,
              input.rate,
              input.effectiveAt,
              input.source,
              user.id,
            ],
          );
          const next = exchangeRateDTO(
            await masterRow(
              client,
              exchangeRateSelect,
              "r",
              companyId,
              result.rows[0].id,
            ),
          );
          await audit(
            client,
            user,
            "exchangeRate.create",
            "exchangeRate",
            next.id,
            null,
            next,
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ exchangeRate });
    }),
  );
  // Keep this literal route before the record detail route.
  router.get(
    `${base}/exchange-rates/effective`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      const currencyId = id(
        typeof req.query.currencyId === "string"
          ? req.query.currencyId
          : undefined,
      );
      const at =
        req.query.at === undefined
          ? new Date().toISOString()
          : parse(effectiveAtSchema, req.query.at);
      const value = await requireSettings(pool, companyId);
      await currencyReference(pool, companyId, currencyId);
      if (currencyId === value.baseCurrencyId) {
        res.json({
          currencyId,
          baseCurrencyId: value.baseCurrencyId,
          at,
          rate: "1",
          exchangeRateId: null,
        });
        return;
      }
      const result = await pool.query(
        `${exchangeRateSelect} WHERE r.company_id=$1 AND r.currency_id=$2 AND r.base_currency_id=$3 AND r.active AND r.effective_at<=$4 ORDER BY r.effective_at DESC,r.id DESC LIMIT 1`,
        [companyId, currencyId, value.baseCurrencyId, at],
      );
      const found = result.rows[0] ? exchangeRateDTO(result.rows[0]) : null;
      res.json({
        currencyId,
        baseCurrencyId: value.baseCurrencyId,
        at,
        rate: found?.rate ?? null,
        exchangeRateId: found?.id ?? null,
      });
    }),
  );
  router.get(
    `${base}/exchange-rates/:id`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "currencies.view");
      res.json({
        exchangeRate: exchangeRateDTO(
          await masterRow(
            pool,
            exchangeRateSelect,
            "r",
            companyId,
            id(req.params.id),
          ),
        ),
      });
    }),
  );
  router.patch(
    `${base}/exchange-rates/:id`,
    handler(async (req, res) => {
      const input = parse(exchangeRatePatchSchema, req.body),
        rateId = id(req.params.id);
      const exchangeRate = await mutateMaster(
        pool,
        req,
        "currencies.manage",
        async (client, user, companyId) => {
          const before = exchangeRateDTO(
            await masterRow(client, exchangeRateSelect, "r", companyId, rateId),
          );
          if (
            input.active &&
            !(await currencyReference(client, companyId, before.currencyId))
              .active
          )
            conflict("فعّل العملة قبل إعادة تفعيل سعر الصرف");
          await client.query(
            "UPDATE exchange_rates SET active=$1 WHERE company_id=$2 AND id=$3",
            [input.active, companyId, rateId],
          );
          const next = exchangeRateDTO(
            await masterRow(client, exchangeRateSelect, "r", companyId, rateId),
          );
          await audit(
            client,
            user,
            "exchangeRate.update",
            "exchangeRate",
            rateId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ exchangeRate });
    }),
  );
  return router;
}

import { Router } from "express";
import type { Pool } from "pg";
import {
  accountBalanceApprovalSchema,
  accountBalanceFollowUpSchema,
  accountStatisticsQuerySchema,
  accountStatisticsReportQuerySchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import {
  assertAccountBalanceAccess,
  assertRequestPagesEnabled,
} from "./services/pages.ts";
import {
  balanceDate,
  postingAccount,
  readBalanceStatistics,
  recordApproval,
  recordFollowUp,
} from "./services/account-balances.ts";
import { readAccountStatisticsReport } from "./services/account-statistics-report.ts";

export function accountStatisticsRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId/accounts/:id";
  router.get(
    "/companies/:companyId/account-statistics-report",
    handler(async (req, res) => {
      const query = parse(accountStatisticsReportQuerySchema, {
        ...req.query,
        q: req.query.q,
        page: req.query.page,
        pageSize: req.query.pageSize,
        active: req.query.active,
        category: req.query.category,
        accountChoice: req.query.accountChoice,
        asOfDate: req.query.asOfDate,
        metrics: req.query.metrics,
        sort: req.query.sort,
      });
      const report = await transaction(pool, async (client) => {
        const companyId = id(req.params.companyId);
        const user = await currentActor(client, actor(req));
        await companyAccess(client, user, companyId, undefined, true);
        await assertAccountBalanceAccess(client, user, companyId);
        await assertRequestPagesEnabled(client, req, true);
        return readAccountStatisticsReport(client, user, companyId, query);
      });
      res.json({ report });
    }),
  );
  router.get(
    `${base}/statistics`,
    handler(async (req, res) => {
      const query = parse(accountStatisticsQuerySchema, {
        ...req.query,
        asOfDate: req.query.asOfDate,
      });
      const statistics = await transaction(pool, async (client) => {
        const companyId = id(req.params.companyId),
          accountId = id(req.params.id);
        const user = await currentActor(client, actor(req));
        await companyAccess(client, user, companyId, undefined, true);
        await assertAccountBalanceAccess(client, user, companyId);
        await assertRequestPagesEnabled(client, req, true);
        await postingAccount(client, companyId, accountId);
        return readBalanceStatistics(
          client,
          user,
          companyId,
          accountId,
          await balanceDate(client, query.asOfDate),
        );
      });
      res.json({ statistics });
    }),
  );
  router.post(
    `${base}/balance-followups`,
    handler(async (req, res) => {
      const input = parse(accountBalanceFollowUpSchema, req.body);
      const followUp = await transaction(pool, async (client) => {
        const companyId = id(req.params.companyId),
          accountId = id(req.params.id);
        const user = await currentActor(client, actor(req));
        await companyAccess(client, user, companyId, undefined, true);
        await assertAccountBalanceAccess(client, user, companyId, "followup");
        await postingAccount(client, companyId, accountId);
        return recordFollowUp(client, req, user, companyId, accountId, input);
      });
      res.status(201).json({ followUp });
    }),
  );
  router.post(
    `${base}/balance-approvals`,
    handler(async (req, res) => {
      const input = parse(accountBalanceApprovalSchema, req.body);
      const approval = await transaction(pool, async (client) => {
        const companyId = id(req.params.companyId),
          accountId = id(req.params.id);
        const user = await currentActor(client, actor(req));
        await companyAccess(client, user, companyId, undefined, true);
        await assertAccountBalanceAccess(client, user, companyId, "approve");
        await postingAccount(client, companyId, accountId);
        return recordApproval(client, req, user, companyId, accountId, input);
      });
      res.status(201).json({ approval });
    }),
  );
  return router;
}

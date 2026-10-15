import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import {
  transactionResetSnapshot,
  deleteCompanyTransactions,
} from "./services/transaction-reset.ts";

const resetSchema = z
  .object({
    idempotencyKey: z.uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationCompanyName: z.string().min(1).max(240),
    deleteAllTransactions: z.literal(true),
  })
  .strict();
export const mcpBodySchemas = { resetSchema };

function snapshotHash(
  companyId: number,
  companyName: string,
  fingerprint: string,
) {
  return createHash("sha256")
    .update(JSON.stringify({ companyId, companyName, fingerprint }))
    .digest("hex");
}

/** Explicit owner maintenance, shared by browser and OAuth. No backup or
 * master-data deletion. A persisted receipt makes an old retry harmless even
 * after new transactions have subsequently been created. */
export function transactionResetRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/transaction-reset",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        const context = await companyAccess(
          client,
          user,
          companyId,
          undefined,
          true,
        );
        await assertRequestPagesEnabled(client, req, true);
        const snapshot = await transactionResetSnapshot(client, companyId);
        return {
          companyId,
          companyName: context.company.name,
          ...snapshot,
          snapshotHash: snapshotHash(
            companyId,
            context.company.name,
            snapshot.fingerprint,
          ),
          preserves: [
            "accounts",
            "items",
            "users",
            "employees",
            "currencies",
            "branches",
            "locations",
            "audit",
            "document-numbering",
          ],
          createsBackup: false,
        };
      });
      res.json(result);
    }),
  );
  router.post(
    "/companies/:companyId/transaction-reset",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const input = parse(resetSchema, req.body);
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        const context = await companyAccess(
          client,
          user,
          companyId,
          undefined,
          true,
        );
        const previous = await client.query(
          "SELECT *,creation_payload=$3::jsonb AS same_payload FROM company_transaction_resets WHERE company_id=$1 AND idempotency_key=$2",
          [companyId, input.idempotencyKey, JSON.stringify(input)],
        );
        if (previous.rows[0]) {
          const accepted = previous.rows[0];
          if (accepted.created_by !== user.id || !accepted.same_payload)
            throw new HttpError(
              409,
              "conflict",
              "استُخدم مفتاح الحذف بطلب مختلف",
            );
          return { ...accepted.result, replayed: true };
        }
        await assertRequestPagesEnabled(client, req, true);
        const before = await transactionResetSnapshot(client, companyId);
        if (
          input.confirmationCompanyName !== context.company.name ||
          input.snapshotHash !==
            snapshotHash(companyId, context.company.name, before.fingerprint)
        )
          throw new HttpError(
            409,
            "conflict",
            "تغيرت بيانات الشركة؛ راجع معاينة الحذف الجديدة أولًا",
          );
        if (before.blockers.length)
          throw new HttpError(409, "conflict", before.blockers.join("؛ "));
        await deleteCompanyTransactions(client, companyId);
        const after = await transactionResetSnapshot(client, companyId);
        const deletedKeys = [
          "invoices",
          "invoiceLines",
          "financialDocuments",
          "financialDocumentLines",
          "stockOperations",
          "stockMovements",
          "stockBalances",
          "documentOptionValues",
          "linkedWalletEntries",
          "sourceImports",
        ];
        const result = {
          companyId,
          companyName: context.company.name,
          deleted: Object.fromEntries(
            deletedKeys.map((key) => [key, before.counts[key] ?? 0]),
          ),
          reset: {
            stockValuations: before.counts.stockValuations ?? 0,
            itemStatistics: before.counts.itemStatistics ?? 0,
          },
          walletAdjustments: before.walletAdjustments,
          remaining: after.counts,
          createsBackup: false,
        };
        await audit(
          client,
          user,
          "company.transactions.reset",
          "company",
          companyId,
          {
            counts: before.counts,
            walletAdjustments: before.walletAdjustments,
          },
          { counts: after.counts, createsBackup: false },
          companyId,
        );
        await client.query(
          "INSERT INTO company_transaction_resets(company_id,idempotency_key,created_by,creation_payload,result) VALUES($1,$2,$3,$4,$5)",
          [
            companyId,
            input.idempotencyKey,
            user.id,
            JSON.stringify(input),
            JSON.stringify(result),
          ],
        );
        return { ...result, replayed: false };
      });
      res.json(result);
    }),
  );
  return router;
}

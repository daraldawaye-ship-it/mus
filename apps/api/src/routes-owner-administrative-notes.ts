import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { mutateMaster } from "./services/masters.ts";
import { audit } from "./services/audit.ts";

// Deliberately separate from the ordinary item/account DTO and PATCH routes:
// staff with items.manage/accounts.manage must never receive these private notes.
const notesSchema = z.object({
  notes: z.string().max(5000),
  expected: z.string().max(5000),
}).strict();

export function ownerAdministrativeNotesRoutes(pool: Pool): Router {
  const router = Router();
  for (const kind of ["items", "accounts"] as const) {
    const table = kind;
    const permission = kind === "items" ? "items.view" : "accounts.view";
    const managePermission = kind === "items" ? "items.manage" : "accounts.manage";
    const entity = kind === "items" ? "item" : "account";
    const path = `/companies/:companyId/${kind}/:id/administrative-notes`;

    router.get(path, handler(async (req, res) => {
      const companyId = id(req.params.companyId), recordId = id(req.params.id);
      const notes = await transaction(pool, async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const user = await currentActor(client, actor(req), false);
        ownerOnly(user);
        await companyAccess(client, user, companyId, permission);
        const result = await client.query(
          `SELECT administrative_notes FROM ${table} WHERE company_id=$1 AND id=$2`,
          [companyId, recordId],
        );
        if (!result.rows[0]) missing();
        return result.rows[0].administrative_notes as string;
      });
      res.json({ notes });
    }));

    router.patch(path, handler(async (req, res) => {
      const companyId = id(req.params.companyId), recordId = id(req.params.id);
      const input = parse(notesSchema, req.body);
      const notes = await mutateMaster(pool, req, managePermission,
        async (client, user, scopedCompanyId) => {
          ownerOnly(user);
          if (scopedCompanyId !== companyId) missing();
          const result = await client.query(
            `SELECT administrative_notes FROM ${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
            [companyId, recordId],
          );
          if (!result.rows[0]) missing();
          const previous = result.rows[0].administrative_notes as string;
          if (previous !== input.expected)
            throw new HttpError(409, "administrative_notes_conflict",
              "تغيرت الملاحظات الإدارية أثناء التحرير؛ انسخ تعديلاتك وأعد فتح الكرت.");
          if (previous === input.notes) return previous;
          await client.query(
            kind === "items"
              ? `UPDATE items SET administrative_notes=$3,revision=revision+1,
                   updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2`
              : `UPDATE accounts SET administrative_notes=$3 WHERE company_id=$1 AND id=$2`,
            [companyId, recordId, input.notes],
          );
          // Record the operation, not the secret text: audit reports may be
          // visible to employees with broader operational permissions.
          await audit(client, user, `${entity}.administrative-notes.update`,
            entity, recordId,
            { field: "administrativeNotes", private: true, changed: true },
            { field: "administrativeNotes", private: true, changed: true },
            companyId);
          return input.notes;
        },
      );
      res.json({ notes });
    }));
  }
  return router;
}

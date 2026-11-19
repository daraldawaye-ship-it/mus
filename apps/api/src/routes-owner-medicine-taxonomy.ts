import { Router, type Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { deny, HttpError } from "./errors.ts";
import { actor, handler, parse } from "./http.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";

// An approval draft, deliberately separate from market cards and compositions.
const item = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).default(""),
}).strict();
const input = z.object({
  expectedRevision: z.number().int().min(0).max(2147483646),
  classifications: z.array(item).max(60),
}).strict().superRefine(({ classifications }, ctx) => {
  const titles = classifications.map(row => row.title.normalize("NFKC").toLocaleLowerCase("ar").replace(/\s+/g, " "));
  if (new Set(classifications.map(row => row.id)).size !== classifications.length || new Set(titles).size !== classifications.length)
    ctx.addIssue({ code: "custom", message: "لا تكرر اسم التصنيف." });
});
type Row = { revision: number; classifications: z.infer<typeof input>["classifications"] };
const path = "/owner/medicine-taxonomy";

export function ownerMedicineTaxonomyRoutes(pool: Pool): Router {
  const router = Router();
  const assertOwner = async (db: Parameters<typeof currentActor>[0], req: Request, write = false) => {
    const authenticated = actor(req);
    if (req.auth?.visitorOnly) deny("هذه المسودة لمالك المنصة فقط.");
    const user = await currentActor(db, authenticated, write);
    ownerOnly(user);
    if (user.suspended) deny();
  };
  router.get(path, handler(async (req, res) => {
    await assertOwner(pool, req);
    const saved = await pool.query<Row>("SELECT revision, classifications FROM owner_medicine_taxonomy_draft WHERE singleton = true");
    res.set("Cache-Control", "private, no-store").json(saved.rows[0] ?? { revision: 0, classifications: [] });
  }));
  router.put(path, handler(async (req, res) => {
    const saved = await transaction(pool, async (db) => {
      await assertOwner(db, req, true);
      const draft = parse(input, req.body);
      const current = (await db.query<Row>("SELECT revision, classifications FROM owner_medicine_taxonomy_draft WHERE singleton = true FOR UPDATE")).rows[0];
      if (!current || current.revision !== draft.expectedRevision)
        throw new HttpError(409, "taxonomy_conflict", "تغيرت المسودة أثناء التحرير. انسخ تعديلاتك وأعد تحميلها أولًا.");
      if (current.classifications.some(old => !draft.classifications.some(row => row.id === old.id)))
        throw new HttpError(400, "taxonomy_delete_not_supported", "لا يمكن حذف التصنيفات المحفوظة في هذه المرحلة.");
      const result = await db.query<Row>(
        "UPDATE owner_medicine_taxonomy_draft SET classifications = $1::jsonb, revision = revision + 1 WHERE singleton = true RETURNING revision, classifications",
        [JSON.stringify(draft.classifications)],
      );
      return result.rows[0];
    });
    res.set("Cache-Control", "private, no-store").json(saved);
  }));
  return router;
}

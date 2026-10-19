import { Router } from "express";
import type { Pool } from "pg";
import {
  branchPatchSchema,
  branchSchema,
  locationKinds,
  locationPatchSchema,
  locationSchema,
} from "../../../packages/contracts/src/index.ts";
import { handler, id, parse } from "./http.ts";
import {
  branchDTO,
  branchSelect,
  locationDTO,
  locationSelect,
} from "./repositories/masters.ts";
import { audit } from "./services/audit.ts";
import { nextCardCode } from "./services/card-codes.ts";
import {
  conflict,
  masterPage,
  masterRow,
  mutateMaster,
  readMaster,
} from "./services/masters.ts";

const branchColumns = {
  id: "b.id",
  code: "b.code",
  name: "b.name",
  phone: "b.phone",
  address: "b.address",
  active: "b.active",
  createdAt: "b.created_at",
};
const locationColumns = {
  id: "l.id",
  branchId: "l.branch_id",
  branchName: "b.name",
  code: "l.code",
  name: "l.name",
  kind: "l.kind",
  active: "l.active",
  branchActive: "b.active",
  effectiveActive: "(l.active AND b.active)",
  createdAt: "l.created_at",
};
const locationFrom =
  "FROM locations l JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id";

export function locationRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";

  router.get(
    `${base}/branches`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "locations.view");
      res.json(
        await masterPage(
          pool,
          req,
          companyId,
          branchSelect,
          "FROM branches b",
          "b",
          branchColumns,
          ["b.code", "b.name", "b.phone", "b.address"],
          branchDTO,
          { active: "boolean" },
          "code:asc",
        ),
      );
    }),
  );
  router.post(
    `${base}/branches`,
    handler(async (req, res) => {
      const input = parse(branchSchema, req.body);
      const branch = await mutateMaster(
        pool,
        req,
        "locations.manage",
        async (client, user, companyId) => {
          const code = input.code ?? await nextCardCode(client, { card: "branch", companyId });
          const result = await client.query(
            "INSERT INTO branches(company_id,code,name,phone,address,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [
              companyId,
              code,
              input.name,
              input.phone,
              input.address,
              input.active,
              user.id,
            ],
          );
          const next = branchDTO(
            await masterRow(
              client,
              branchSelect,
              "b",
              companyId,
              result.rows[0].id,
            ),
          );
          const created = await client.query(
            "INSERT INTO locations(company_id,branch_id,code,name,kind,created_by) VALUES($1,$2,'SHOWROOM','المعرض','showroom',$3) RETURNING id",
            [companyId, next.id, user.id],
          );
          const showroom = locationDTO(
            await masterRow(
              client,
              locationSelect,
              "l",
              companyId,
              created.rows[0].id,
            ),
          );
          await audit(
            client,
            user,
            "branch.create",
            "branch",
            next.id,
            null,
            next,
            companyId,
          );
          await audit(
            client,
            user,
            "location.create",
            "location",
            showroom.id,
            null,
            showroom,
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ branch });
    }),
  );
  router.get(
    `${base}/branches/:id`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "locations.view");
      res.json({
        branch: branchDTO(
          await masterRow(
            pool,
            branchSelect,
            "b",
            companyId,
            id(req.params.id),
          ),
        ),
      });
    }),
  );
  router.patch(
    `${base}/branches/:id`,
    handler(async (req, res) => {
      const input = parse(branchPatchSchema, req.body),
        branchId = id(req.params.id);
      const branch = await mutateMaster(
        pool,
        req,
        "locations.manage",
        async (client, user, companyId) => {
          const before = branchDTO(
            await masterRow(client, branchSelect, "b", companyId, branchId),
          );
          await client.query(
            "UPDATE branches SET name=$1,phone=$2,address=$3,active=$4 WHERE company_id=$5 AND id=$6",
            [
              input.name ?? before.name,
              input.phone ?? before.phone,
              input.address ?? before.address,
              input.active ?? before.active,
              companyId,
              branchId,
            ],
          );
          const next = branchDTO(
            await masterRow(client, branchSelect, "b", companyId, branchId),
          );
          await audit(
            client,
            user,
            "branch.update",
            "branch",
            branchId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ branch });
    }),
  );

  router.get(
    `${base}/locations`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "locations.view");
      res.json(
        await masterPage(
          pool,
          req,
          companyId,
          locationSelect,
          locationFrom,
          "l",
          locationColumns,
          ["l.code", "l.name", "b.name"],
          locationDTO,
          { branchId: "id", kind: locationKinds, active: "boolean" },
          "code:asc",
        ),
      );
    }),
  );
  router.post(
    `${base}/locations`,
    handler(async (req, res) => {
      const input = parse(locationSchema, req.body);
      const location = await mutateMaster(
        pool,
        req,
        "locations.manage",
        async (client, user, companyId) => {
          const branch = await client.query(
            "SELECT active FROM branches WHERE company_id=$1 AND id=$2",
            [companyId, input.branchId],
          );
          if (!branch.rows[0]?.active)
            conflict("إنشاء الموقع يحتاج فرعًا فعالًا من الشركة");
          if (input.kind === "showroom") {
            const showroom = await client.query(
              "SELECT 1 FROM locations WHERE company_id=$1 AND branch_id=$2 AND kind='showroom' LIMIT 1",
              [companyId, input.branchId],
            );
            if (showroom.rowCount) conflict("يوجد معرض لهذا الفرع بالفعل");
          }
          const code = input.code ?? await nextCardCode(client, {
            card: input.kind === "returns" ? "returns" : "warehouse",
            companyId, branchId: input.branchId,
          });
          const result = await client.query(
            "INSERT INTO locations(company_id,branch_id,code,name,kind,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
            [
              companyId,
              input.branchId,
              code,
              input.name,
              input.kind,
              user.id,
            ],
          );
          const next = locationDTO(
            await masterRow(
              client,
              locationSelect,
              "l",
              companyId,
              result.rows[0].id,
            ),
          );
          await audit(
            client,
            user,
            "location.create",
            "location",
            next.id,
            null,
            next,
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ location });
    }),
  );
  router.get(
    `${base}/locations/:id`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "locations.view");
      res.json({
        location: locationDTO(
          await masterRow(
            pool,
            locationSelect,
            "l",
            companyId,
            id(req.params.id),
          ),
        ),
      });
    }),
  );
  router.patch(
    `${base}/locations/:id`,
    handler(async (req, res) => {
      const input = parse(locationPatchSchema, req.body),
        locationId = id(req.params.id);
      const location = await mutateMaster(
        pool,
        req,
        "locations.manage",
        async (client, user, companyId) => {
          const before = locationDTO(
            await masterRow(client, locationSelect, "l", companyId, locationId),
          );
          if (input.active === true && !before.branchActive)
            conflict("يجب تفعيل الفرع قبل تفعيل الموقع");
          await client.query(
            "UPDATE locations SET name=$1,active=$2 WHERE company_id=$3 AND id=$4",
            [
              input.name ?? before.name,
              input.active ?? before.active,
              companyId,
              locationId,
            ],
          );
          const next = locationDTO(
            await masterRow(client, locationSelect, "l", companyId, locationId),
          );
          await audit(
            client,
            user,
            "location.update",
            "location",
            locationId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ location });
    }),
  );
  return router;
}

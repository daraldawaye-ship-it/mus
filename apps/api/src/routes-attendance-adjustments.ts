import { Router } from "express";
import type { Pool } from "pg";
import { attendanceAdjustmentSchema } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, deny, missing } from "./errors.ts";
import {
  assertDirectoryAccess,
  assertRequestPagesEnabled,
  directoryEntries,
} from "./services/pages.ts";
import {
  loadAttendanceRecord,
  postAttendancePoints,
} from "./services/attendance-rewards.ts";
import { audit } from "./services/audit.ts";

export function attendanceAdjustmentRoutes(pool: Pool) {
  const router = Router();
  router.post(
    "/companies/:companyId/attendance/adjustments",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        input = parse(attendanceAdjustmentSchema, req.body);
      const { idempotencyKey, ...payload } = input;
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        const context = await companyAccess(
          client,
          user,
          companyId,
          undefined,
          true,
        );
        if (!context.general) deny("تعويض وخصم نقاط الدوام للإدارة فقط");
        const existing = (
          await client.query(
            `SELECT id,points::text AS points,created_by,request_payload=$3::jsonb AS matches
        FROM attendance_point_entries WHERE company_id=$1 AND idempotency_key=$2`,
            [companyId, idempotencyKey, JSON.stringify(payload)],
          )
        ).rows[0];
        if (existing) {
          if (existing.created_by !== user.id || !existing.matches)
            throw new HttpError(
              409,
              "conflict",
              "مفتاح الطلب مستخدم لعملية أو مستخدم آخر",
            );
          return {
            adjustment: { id: existing.id, points: existing.points },
            created: false,
          };
        }
        await assertRequestPagesEnabled(client, req, true);
        assertDirectoryAccess(
          (await directoryEntries(client, user, companyId)).find(
            (e) => e.key === "company.attendance",
          )!,
          "edit",
        );
        const record = await loadAttendanceRecord(
          client,
          companyId,
          input.recordId,
        );
        if (
          !(
            await client.query(
              "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
              [companyId, record.employee_id],
            )
          ).rowCount
        )
          missing();
        const points = BigInt(input.points);
        if (points < 0n) {
          const balance = (
            await client.query(
              `SELECT (w.points-COALESCE((SELECT sum(points) FROM wallet_conversions c
          WHERE c.company_id=w.company_id AND c.employee_id=w.employee_id AND c.status='pending'),0))::text AS available
          FROM employee_wallets w WHERE w.company_id=$1 AND w.employee_id=$2 FOR UPDATE`,
              [companyId, record.employee_id],
            )
          ).rows[0];
          if (!balance || BigInt(balance.available) < -points)
            throw new HttpError(
              400,
              "insufficient_points",
              "النقاط المتاحة لا تكفي للخصم؛ لا يمكن خصم نقاط محجوزة للتحويل",
            );
        }
        const adjustment = await postAttendancePoints(client, {
          companyId,
          record,
          user,
          kind: "adjustment",
          points,
          reason: input.reason,
          idempotencyKey,
          payload,
        });
        await audit(
          client,
          user,
          "attendance.adjustment",
          "attendance",
          record.id,
          null,
          {
            adjustmentId: adjustment.id,
            employeeId: record.employee_id,
            points: input.points,
            reason: input.reason,
          },
          companyId,
        );
        return { adjustment, created: true };
      });
      res
        .status(result.created ? 201 : 200)
        .json({ adjustment: result.adjustment });
    }),
  );
  return router;
}

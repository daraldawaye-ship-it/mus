import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, deny, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { getAttendanceSettings } from "./services/attendance-settings.ts";
import { attendanceAutoHours } from "./services/control-values.ts";
import { awardAttendanceCheckIn, closeAttendanceRecord } from "./services/attendance-rewards.ts";

const deviceSchema = z.object({ deviceId: z.string().uuid() }).strict();
const decisionSchema = deviceSchema.extend({ approved: z.boolean() });
type KnownUser = Awaited<ReturnType<typeof currentActor>>;

async function pharmacyDevice(client: PoolClient, companyId: number, deviceId: string) {
  const hash = createHash("sha256").update(deviceId).digest("hex");
  const device = (await client.query(
    "SELECT id FROM company_known_devices WHERE company_id=$1 AND identity_hash=$2 AND category='pharmacy' AND approved=true",
    [companyId, hash],
  )).rows[0];
  return device?.id as string | undefined;
}

async function notifyRejected(
  client: PoolClient,
  row: { id: string; company_id: number; employee_id: number; kind: string; employee_name: string; work_date: string },
  approver: KnownUser,
) {
  const action = row.kind === "check-in" ? "الحضور" : "الانصراف";
  await client.query(
    `INSERT INTO notifications(company_id,code,recipient_user_id,subject_employee_id,subject_key,event_key,title,message,importance,href,assigned)
      SELECT $1,'ATTENDANCE_APPROVAL_REJECTED',recipient.id,$2,$3,$4,$5,$6,'high',$7,true
      FROM users recipient
      LEFT JOIN employees reviewer ON reviewer.company_id=$1 AND reviewer.user_id=recipient.id AND reviewer.active
      WHERE NOT recipient.archived AND (recipient.owner OR
        reviewer.position_keys && ARRAY['sales-supervisor','cashier']::text[])
      ON CONFLICT DO NOTHING`,
    [row.company_id, row.employee_id, `attendance-approval:${row.id}`,
      `attendance-approval:${row.id}:rejected`,
      `عدم مصادقة ${action} ${row.employee_name}`,
      `رفض ${approver.displayName} مصادقة ${action} للموظف ${row.employee_name}.`,
      `/companies/${row.company_id}/attendance?day=${row.work_date}`],
  );
}

export function attendanceApprovalRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/attendance/approval-requests";

  // Only an explicitly approved pharmacy installation may see another user's
  // requests. A device registered merely by visiting is NOT trusted.
  router.get(base, handler(async (req, res) => {
    const deviceId = parse(z.string().uuid(), req.query.deviceId);
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION READ ONLY");
      const companyId = id(req.params.companyId);
      const user = await currentActor(client, actor(req), false);
      await companyAccess(client, user, companyId);
      if (!await pharmacyDevice(client, companyId, deviceId)) return { items: [] };
      const rows = await client.query(
        `SELECT p.id::text,p.kind,p.record_id AS "recordId",p.requested_at AS "requestedAt",
          e.name AS "employeeName"
         FROM attendance_punch_approvals p JOIN employees e
           ON e.company_id=p.company_id AND e.id=p.employee_id
         WHERE p.company_id=$1 AND p.status='pending' AND p.requester_user_id<>$2
         ORDER BY p.requested_at,p.id LIMIT 30`,
        [companyId, user.id],
      );
      return { items: rows.rows };
    });
    res.json(result);
  }));

  router.post(base + "/:approvalId/resolve", handler(async (req, res) => {
    const input = parse(decisionSchema, req.body);
    const result = await transaction(pool, async client => {
      const companyId = id(req.params.companyId);
      const approvalId = id(req.params.approvalId);
      const user = await currentActor(client, actor(req), true);
      await companyAccess(client, user, companyId, undefined, true);
      const deviceId = await pharmacyDevice(client, companyId, input.deviceId);
      if (!deviceId) deny("مصادقة الدوام متاحة من جهاز صيدلية معتمد فقط");
      const row = (await client.query(
        `SELECT p.*,p.work_date::text AS work_date,e.name AS employee_name
         FROM attendance_punch_approvals p JOIN employees e
          ON e.company_id=p.company_id AND e.id=p.employee_id
         WHERE p.company_id=$1 AND p.id=$2 FOR UPDATE OF p`,
        [companyId, approvalId],
      )).rows[0];
      if (!row) missing("طلب المصادقة غير موجود");
      if (row.requester_user_id === user.id) deny("لا يمكن للموظف مصادقة حضوره أو انصرافه بنفسه");
      // SELECT FOR UPDATE serializes simultaneous approvals. No later click wins.
      if (row.status !== "pending") return { status: row.status, alreadyHandled: true };

      let recordId = row.record_id as number | null;
      if (input.approved && row.kind === "check-in") {
        const open = (await client.query(
          "SELECT id,checked_in_at,automatic_checkout_hours FROM attendance_records WHERE company_id=$1 AND employee_id=$2 AND checked_out_at IS NULL FOR UPDATE",
          [companyId, row.employee_id],
        )).rows[0];
        if (open) {
          const expired = new Date(row.requested_at).getTime() >=
            new Date(open.checked_in_at).getTime() + Number(open.automatic_checkout_hours) * 3600_000;
          if (!expired) throw new HttpError(409,"attendance_open","الموظف لديه جلسة حضور مفتوحة؛ لا يمكن اعتماد طلب آخر");
          await closeAttendanceRecord(client, {
            companyId, recordId: open.id, actorUser: null,
            now: new Date(row.requested_at),
          });
        }
        const settings = await getAttendanceSettings(client, companyId, row.employee_id);
        if (settings.defaultDailyHours !== null) {
          await client.query(
            "INSERT INTO attendance_day_policies(company_id,employee_id,work_date,default_daily_hours,allow_overtime) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [companyId,row.employee_id,row.work_date,settings.defaultDailyHours,settings.allowOvertime],
          );
        }
        const inserted = (await client.query(
          `INSERT INTO attendance_records(company_id,employee_id,employee_name,work_date,checked_in_at,idempotency_key,created_by,updated_by,
            hourly_points,default_daily_hours,expected_start_time,allow_overtime,settings_revision,automatic_checkout_hours)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [companyId,row.employee_id,row.employee_name,row.work_date,row.requested_at,row.idempotency_key,
            row.requester_user_id,user.id,settings.hourlyPoints,settings.defaultDailyHours,settings.expectedStartTime,
            settings.allowOvertime,settings.revision,await attendanceAutoHours(client,companyId)],
        )).rows[0];
        recordId = inserted.id;
        await awardAttendanceCheckIn(client, companyId, recordId!, user);
        await audit(client,user,"attendance.checkIn","attendance",recordId,null,
          { checkedInAt: row.requested_at, approvedBy: user.displayName },companyId);
      }
      const status = input.approved ? "approved" : "rejected";
      await client.query(
        `UPDATE attendance_punch_approvals
         SET status=$3,record_id=$4,decided_by=$5,decided_at=clock_timestamp(),decision_device_id=$6
         WHERE company_id=$1 AND id=$2 AND status='pending'`,
        [companyId, approvalId, status, recordId, user.id, deviceId],
      );
      await audit(client,user,input.approved ? "attendance.approval.accept" : "attendance.approval.reject",
        "attendance-approval",approvalId,{ status:"pending" },
        { status,kind:row.kind,employeeId:row.employee_id,recordId,approvedBy:user.displayName },companyId);
      if (!input.approved) await notifyRejected(client,row,user);
      return { status, alreadyHandled: false };
    });
    res.json(result);
  }));
  return router;
}

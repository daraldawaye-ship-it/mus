import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";
import { emitNotification } from "./notifications.ts";
import { HttpError, missing } from "../errors.ts";

const HOUR_MICROS = 3_600_000_000n;
export const attendanceRewardJoin = `LEFT JOIN LATERAL (
 SELECT COALESCE(sum(eligible_microseconds),0)::text AS paid_microseconds,
 COALESCE(sum(points),0)::text AS awarded_points FROM attendance_point_entries p
 WHERE p.company_id=r.company_id AND p.attendance_record_id=r.id) rewards ON true`;
export async function loadAttendanceRecord(
  client: PoolClient,
  companyId: number,
  recordId: number,
) {
  const row = (
    await client.query(
      `SELECT r.*,r.work_date::text AS work_date,
   r.start_time::text AS start_time,r.end_time::text AS end_time,
   rewards.paid_microseconds,rewards.awarded_points FROM attendance_records r ${attendanceRewardJoin}
   WHERE r.company_id=$1 AND r.id=$2`,
      [companyId, recordId],
    )
  ).rows[0];
  if (!row) missing();
  return row;
}

export async function postAttendancePoints(
  client: PoolClient,
  input: {
    companyId: number;
    record: QueryResultRow;
    user: User;
    kind: "worked" | "punctual" | "adjustment";
    points: bigint;
    eligibleMicros?: bigint;
    numerator?: bigint;
    reason: string;
    idempotencyKey?: string;
    payload: object;
  },
) {
  const source = (
    await client.query(
      `INSERT INTO attendance_point_entries
   (company_id,employee_id,work_date,attendance_record_id,kind,points,eligible_microseconds,weighted_numerator,
    reason,idempotency_key,request_payload,created_by,created_by_name)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,points::text AS points`,
      [
        input.companyId,
        input.record.employee_id,
        input.record.work_date,
        input.record.id,
        input.kind,
        input.points.toString(),
        (input.eligibleMicros ?? 0n).toString(),
        (input.numerator ?? 0n).toString(),
        input.reason,
        input.idempotencyKey ?? randomUUID(),
        JSON.stringify(input.payload),
        input.user.id,
        input.user.displayName,
      ],
    )
  ).rows[0];
  if (input.points !== 0n) {
    const ledger = (
      await client.query(
        `INSERT INTO employee_wallet_entries
      (company_id,employee_id,employee_name,kind,points,reason,attendance_entry_id,idempotency_key,request_payload,created_by,created_by_name)
      VALUES($1,$2,$3,'attendance',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          input.companyId,
          input.record.employee_id,
          input.record.employee_name,
          input.points.toString(),
          input.reason,
          source.id,
          randomUUID(),
          JSON.stringify({ ...input.payload, attendanceEntryId: source.id }),
          input.user.id,
          input.user.displayName,
        ],
      )
    ).rows[0];
    await audit(
      client,
      input.user,
      input.kind === "adjustment" ? "attendance.adjustment" : "wallet.auto-award",
      "wallet-entry",
      ledger.id,
      null,
      {
        source: "attendance",
        attendanceEntryId: source.id,
        attendanceRecordId: input.record.id,
        points: input.points.toString(),
        kind: input.kind,
      },
      input.companyId,
    );
  }
  return source as { id: number; points: string };
}

/** Only the first punch of a work date can earn the requested 50-point bonus. */
export async function awardAttendanceCheckIn(
  client: PoolClient,
  companyId: number,
  recordId: number,
  user: User,
): Promise<void> {
  const row = (
    await client.query(
      `SELECT r.*,r.work_date::text AS work_date,
    (r.expected_start_time IS NOT NULL AND r.checked_in_at<=((r.work_date+r.expected_start_time) AT TIME ZONE 'Asia/Aden')+interval '10 minutes') AS eligible
    FROM attendance_records r WHERE r.company_id=$1 AND r.id=$2`,
      [companyId, recordId],
    )
  ).rows[0];
  if (!row?.eligible) return;
  const first = (
    await client.query(
      `SELECT id FROM attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3 ORDER BY checked_in_at,id LIMIT 1`,
      [companyId, row.employee_id, row.work_date],
    )
  ).rows[0];
  if (first?.id !== recordId) return;
  if (
    (
      await client.query(
        "SELECT 1 FROM attendance_point_entries WHERE company_id=$1 AND employee_id=$2 AND work_date=$3 AND kind='punctual'",
        [companyId, row.employee_id, row.work_date],
      )
    ).rowCount
  )
    return;
  await postAttendancePoints(client, {
    companyId,
    record: row,
    user,
    kind: "punctual",
    points: 50n,
    reason: "مكافأة الحضور ضمن الوقت المتوقع وسماح عشر دقائق",
    payload: {
      source: "attendance-punctual",
      recordId,
      workDate: row.work_date,
      points: "50",
      expectedStartTime: row.expected_start_time,
    },
  });
}

async function awardWorkedPoints(
  client: PoolClient,
  companyId: number,
  row: QueryResultRow,
  user: User,
) {
  if (
    (
      await client.query(
        "SELECT 1 FROM attendance_point_entries WHERE company_id=$1 AND attendance_record_id=$2 AND kind='worked'",
        [companyId, row.id],
      )
    ).rowCount
  )
    return;
  const duration = (
    await client.query(
      "SELECT FLOOR(EXTRACT(EPOCH FROM checked_out_at-checked_in_at)*1000000)::text AS micros FROM attendance_records WHERE company_id=$1 AND id=$2",
      [companyId, row.id],
    )
  ).rows[0];
  const actual = BigInt(duration.micros);
  const daily = (
    await client.query(
      `SELECT default_daily_hours::text,allow_overtime FROM attendance_day_policies WHERE company_id=$1 AND employee_id=$2 AND work_date=$3`,
      [companyId, row.employee_id, row.work_date],
    )
  ).rows[0];
  const totals = (
    await client.query(
      `SELECT COALESCE(sum(eligible_microseconds),0)::text AS eligible,
    COALESCE(sum(weighted_numerator),0)::text AS numerator,COALESCE(sum(points),0)::text AS points
    FROM attendance_point_entries WHERE company_id=$1 AND employee_id=$2 AND work_date=$3 AND kind='worked'`,
      [companyId, row.employee_id, row.work_date],
    )
  ).rows[0];
  // Every confirmed earlier session consumes the daily hours limit, including unset/zero-rate sessions.
  const previous = (
    await client.query(
      `SELECT COALESCE(sum(FLOOR(EXTRACT(EPOCH FROM r.checked_out_at-r.checked_in_at)*1000000)),0)::text AS micros
    FROM attendance_records r WHERE r.company_id=$1 AND r.employee_id=$2 AND r.work_date=$3 AND r.id<>$4
    AND r.checked_out_at IS NOT NULL AND NOT r.needs_review`,
      [companyId, row.employee_id, row.work_date, row.id],
    )
  ).rows[0];
  let eligible = 0n;
  if (
    row.hourly_points !== null &&
    daily?.default_daily_hours !== null &&
    daily
  ) {
    if (daily.allow_overtime) eligible = actual;
    else {
      const [whole, fraction = ""] = String(daily.default_daily_hours).split(
        ".",
      );
      const cap =
        (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))) * 36_000_000n;
      const used = BigInt(previous.micros);
      eligible = used >= cap ? 0n : actual < cap - used ? actual : cap - used;
    }
  }
  const numerator = eligible * BigInt(row.hourly_points ?? "0");
  const points =
    (BigInt(totals.numerator) + numerator) / HOUR_MICROS -
    BigInt(totals.points);
  await postAttendancePoints(client, {
    companyId,
    record: row,
    user,
    kind: "worked",
    points,
    eligibleMicros: eligible,
    numerator,
    reason: `نقاط الدوام ليوم ${row.work_date}`,
    payload: {
      source: "attendance-worked",
      recordId: row.id,
      workDate: row.work_date,
      hourlyPoints: row.hourly_points,
      actualMicroseconds: actual.toString(),
      eligibleMicroseconds: eligible.toString(),
      points: points.toString(),
      settingsRevision: row.settings_revision,
    },
  });
}

/** Caller holds actor-before-company locks. Closing and earning are one transaction. */
export async function closeAttendanceRecord(
  client: PoolClient,
  input: {
    companyId: number;
    recordId: number;
    actorUser: User | null;
    now?: Date;
  },
) {
  const row = (
    await client.query(
      "SELECT r.*,r.work_date::text AS work_date FROM attendance_records r WHERE r.company_id=$1 AND r.id=$2 FOR UPDATE",
      [input.companyId, input.recordId],
    )
  ).rows[0];
  if (!row) missing();
  if (row.checked_out_at)
    return loadAttendanceRecord(client, input.companyId, input.recordId);
  const now =
    input.now?.toISOString() ??
    ((await client.query("SELECT clock_timestamp()::text AS now")).rows[0]
      .now as string);
  const auto = (
    await client.query(
      "SELECT $1::timestamptz>=checked_in_at+interval '16 hours' AS automatic FROM attendance_records WHERE company_id=$2 AND id=$3",
      [now, input.companyId, input.recordId],
    )
  ).rows[0].automatic as boolean;
  if (!input.actorUser && !auto)
    throw new HttpError(409, "not_due", "لم يحن موعد الانصراف الآلي");
  await client.query(
    `UPDATE attendance_records SET checked_out_at=CASE WHEN $3::boolean THEN checked_in_at+interval '16 hours' ELSE $4::timestamptz END,
    close_source=CASE WHEN $3::boolean THEN 'automatic' ELSE 'manual' END,needs_review=$3,
    revision=revision+1,updated_by=$5,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2`,
    [
      input.companyId,
      input.recordId,
      auto,
      now,
      input.actorUser?.id ?? row.created_by,
    ],
  );
  let saved = await loadAttendanceRecord(
    client,
    input.companyId,
    input.recordId,
  );
  if (!auto && input.actorUser) {
    await awardWorkedPoints(client, input.companyId, saved, input.actorUser);
    saved = await loadAttendanceRecord(client, input.companyId, input.recordId);
  }
  await audit(
    client,
    input.actorUser,
    auto ? "attendance.autoCheckOut" : "attendance.checkOut",
    "attendance",
    row.id,
    { checkedOutAt: null },
    {
      checkedOutAt: saved.checked_out_at.toISOString(),
      closeSource: saved.close_source,
      needsReview: saved.needs_review,
      points: saved.awarded_points,
    },
    input.companyId,
  );
  if (auto)
    await emitNotification(client, {
      code: "ATTENDANCE_OPEN_16H",
      companyId: input.companyId,
      subjectEmployeeId: row.employee_id,
      subjectKey: `attendance:${row.id}`,
      eventKey: `attendance:${row.id}:auto-close`,
      message: `${row.employee_name}: أُغلق الحضور آليًا بعد 16 ساعة ويحتاج مراجعة. تعالج الفروق بتعويض أو خصم نقاط دون تعديل وقت السجل.`,
      href: `/companies/${input.companyId}/attendance?day=${row.work_date}`,
    });
  return saved;
}

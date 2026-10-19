import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { transaction } from "../apps/api/src/db.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import {
  emitNotification,
  refreshNotificationReminders,
} from "../apps/api/src/services/notifications.ts";
import type {
  Company,
  Employee,
  NotificationDirectory,
  NotificationTemplate,
  NotificationTemplateDirectory,
  Page,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// Only the notification workflow and its first automatic sources are exercised.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "notifications-test-passphrase";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}

  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(this.baseUrl + "/api" + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie())
      this.cookie = /max-age=0/i.test(cookie) ? "" : cookie.split(";", 1)[0]!;
    const parsed = (await response.json()) as T;
    if (parsed && typeof parsed === "object" && "csrf" in parsed)
      this.csrf = (parsed as { csrf: string | null }).csrf;
    return { status: response.status, body: parsed };
  }

  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const response = await this.request<T>(method, path, body);
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(response.body)}`,
    );
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `notifications_${randomUUID().replaceAll("-", "")}`;
  const runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  const server: Server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  const owner = new Client(baseUrl);
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Notification owner",
    displayName: "Owner",
    email: "notification-owner@example.test",
    password,
  });
  await owner.ok("POST", "/auth/login", { email: ownerUser.email, password });
  async function company(name: string) {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  }
  async function staff(companyId: number, name: string) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name,
        displayName: name,
        email: `${randomUUID()}@example.test`,
        phone: "",
        password,
      },
      201,
    );
    assert(session.user);
    const { employee } = await owner.ok<{ employee: Employee }>(
      "POST",
      `/companies/${companyId}/employees`,
      {
        userId: session.user.id,
        name,
        phone: "",
        role: "employee",
        active: true,
        permissions: [],
      },
      201,
    );
    return { client, user: session.user, employee };
  }
  return { pool: runtime.pool, owner, ownerUser, company, staff };
}

const settings = (template: NotificationTemplate) => ({
  importance: template.importance,
  enabled: template.enabled,
  canSnooze: template.canSnooze,
  allowRepeat: template.allowRepeat,
  repeatInterval: template.repeatInterval,
  notifyManagers: template.notifyManagers,
  notifySubject: template.notifySubject,
  roleIds: template.roleIds,
  employeeIds: template.employeeIds,
  revision: template.revision,
});

test("automatic notifications separate reading from completion, validate follow-up and isolate company recipients", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Notification company");
  const other = await f.company("Other notification company");
  const subject = await f.staff(company.id, "Subject employee");
  const peer = await f.staff(company.id, "Peer employee");
  const foreign = await f.staff(other.id, "Foreign employee");
  const manager = await f.staff(company.id, "General manager");
  const base = `/companies/${company.id}`;
  const otherBase = `/companies/${other.id}`;
  await f.owner.ok(
    "POST",
    otherBase + "/employees",
    {
      userId: subject.user.id,
      name: "Subject in other company",
      phone: "",
      role: "employee",
      active: true,
      permissions: [],
    },
    201,
  );
  await f.owner.ok(
    "PATCH",
    base + `/employees/${manager.employee.id}/manager`,
    {
      isGeneralManager: true,
    },
  );
  assert.equal(
    (await subject.client.request("POST", base + "/notifications", {})).status,
    404,
  );
  assert.equal(
    (await subject.client.request("GET", base + "/notification-templates"))
      .status,
    403,
  );
  assert.equal(
    (await foreign.client.request("GET", base + "/notifications")).status,
    403,
  );

  const directory = () =>
    f.owner.ok<NotificationTemplateDirectory>(
      "GET",
      base + "/notification-templates",
    );
  const getTemplate = async () => {
    const template = (await directory()).templates.find(
      (row) => row.code === "ATTENDANCE_LATE",
    );
    assert(template);
    return template;
  };
  const initial = await getTemplate();
  assert.equal(initial.repeatInterval, "none");
  assert.equal(initial.allowRepeat, false);
  assert.equal(
    (
      await f.owner.request(
        "PUT",
        base + "/notification-templates/ATTENDANCE_LATE",
        {
          ...settings(initial),
          employeeIds: [foreign.employee.id],
        },
      )
    ).status,
    400,
  );
  await f.owner.ok("PUT", base + "/notification-templates/ATTENDANCE_LATE", {
    ...settings(initial),
    importance: "high",
    notifySubject: true,
  });
  assert.equal(
    (
      await f.owner.request(
        "PUT",
        base + "/notification-templates/ATTENDANCE_LATE",
        settings(initial),
      )
    ).status,
    409,
  );
  const event = {
    code: "ATTENDANCE_LATE",
    companyId: company.id,
    subjectEmployeeId: subject.employee.id,
    subjectKey: `employee:${subject.employee.id}:day`,
    eventKey: "attendance:first",
    message: "تأخر الموظف التجريبي",
    href: base + "/attendance",
  };
  const emit = (eventKey: string) =>
    transaction(f.pool, (client) =>
      emitNotification(client, { ...event, eventKey }),
    );
  await Promise.all([emit(event.eventKey), emit(event.eventKey)]);
  const inbox = (client: Client, state = "all", target = base) =>
    client.ok<NotificationDirectory>(
      "GET",
      target + `/notifications?state=${state}`,
    );
  const own = async (id: number) => {
    const record = (await inbox(subject.client)).items.find(
      (row) => row.id === id,
    );
    assert(record);
    return record;
  };
  const before = await inbox(subject.client);
  assert.equal(before.total, 1);
  assert.equal(before.unread, 1);
  assert.equal(before.items[0]!.importance, "high");
  assert.equal((await inbox(peer.client)).total, 0);
  assert.equal((await inbox(manager.client)).total, 1);
  const notification = before.items[0]!;
  assert.equal(
    (
      await peer.client.request(
        "POST",
        base + `/notifications/${notification.id}/action`,
        {
          action: "complete",
          revision: notification.revision,
        },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await subject.client.request(
        "POST",
        otherBase + `/notifications/${notification.id}/action`,
        {
          action: "complete",
          revision: notification.revision,
        },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await subject.client.request(
        "POST",
        `/notifications/${notification.id}/action`,
        {
          action: "complete",
          revision: notification.revision,
        },
      )
    ).status,
    404,
  );
  const act = async (body: Record<string, unknown>) =>
    subject.client.ok(
      "POST",
      base + `/notifications/${notification.id}/action`,
      body,
    );
  await act({ action: "read", revision: notification.revision });
  const read = await own(notification.id);
  assert(read.readAt);
  assert.equal(read.completedAt, null);
  assert.equal((await inbox(subject.client)).unread, 0);
  await emit("attendance:another-event");
  assert.equal(
    (await inbox(subject.client)).total,
    1,
    "An unfinished reason must not generate another notification",
  );
  assert.equal(
    (
      await subject.client.request(
        "POST",
        base + `/notifications/${notification.id}/action`,
        {
          action: "complete",
          revision: notification.revision,
        },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await subject.client.request(
        "POST",
        base + `/notifications/${notification.id}/action`,
        {
          action: "snooze",
          revision: read.revision,
          until: "2000-01-01T00:00:00Z",
        },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await subject.client.request(
        "POST",
        base + `/notifications/${notification.id}/action`,
        {
          action: "repeat",
          revision: read.revision,
          repeatInterval: "day",
        },
      )
    ).status,
    400,
  );
  const until = new Date(Date.now() + 86400_000).toISOString();
  await act({ action: "snooze", revision: read.revision, until });
  assert.equal((await inbox(subject.client, "active")).total, 0);
  assert.equal((await inbox(subject.client, "snoozed")).total, 1);
  const snoozed = await own(notification.id);
  assert.equal(snoozed.snoozedUntil, until);
  const currentSettings = await getTemplate();
  await f.owner.ok("PUT", base + "/notification-templates/ATTENDANCE_LATE", {
    ...settings(currentSettings),
    allowRepeat: true,
    repeatInterval: "none",
  });
  let repeated = snoozed;
  for (const repeatInterval of ["day", "week", "month"] as const) {
    await act({
      action: "repeat",
      revision: repeated.revision,
      repeatInterval,
    });
    repeated = await own(notification.id);
    assert.equal(repeated.repeatInterval, repeatInterval);
  }
  await f.pool.query(
    "UPDATE notifications SET next_reminder_at=now()-interval '1 second',snoozed_until=now()-interval '1 second',revision=revision+1 WHERE id=$1",
    [notification.id],
  );
  await transaction(f.pool, (client) =>
    refreshNotificationReminders(client, company.id),
  );
  const reminder = await own(notification.id);
  assert.equal(reminder.reminderCount, 1);
  assert.equal(reminder.readAt, null);
  assert.equal(reminder.snoozedUntil, null);
  assert.equal((await inbox(subject.client)).total, 1);
  assert.equal(
    (
      await subject.client.request(
        "POST",
        base + `/notifications/${notification.id}/action`,
        {
          action: "assign",
          revision: reminder.revision,
          employeeId: peer.employee.id,
          repeatInterval: "none",
        },
      )
    ).status,
    403,
  );
  const managerRow = (await inbox(f.owner)).items.find(
    (row) => row.code === event.code,
  )!;
  assert.equal(
    (
      await f.owner.request(
        "POST",
        base + `/notifications/${managerRow.id}/action`,
        {
          action: "assign",
          revision: managerRow.revision,
          employeeId: foreign.employee.id,
          repeatInterval: "none",
        },
      )
    ).status,
    400,
  );
  await f.owner.ok("POST", base + `/notifications/${managerRow.id}/action`, {
    action: "assign",
    revision: managerRow.revision,
    employeeId: peer.employee.id,
    repeatInterval: "none",
  });
  assert.equal((await inbox(peer.client)).total, 1);

  await f.owner.ok(
    "PATCH",
    base + `/employees/${manager.employee.id}/manager`,
    { isGeneralManager: false },
  );
  assert.equal(
    (await inbox(manager.client)).total,
    0,
    "Manager-only recipients must lose access immediately after demotion",
  );
  const { role } = await f.owner.ok<{ role: { id: number } }>(
    "POST",
    base + "/configuration/roles",
    {
      key: "alert-followers",
      name: "متابعة التنبيهات",
      description: "",
    },
    201,
  );
  const assignmentDraft = {
    employeeId: manager.employee.id,
    roleId: role.id,
    active: true,
    revision: null,
  };
  const { assignment } = await f.owner.ok<{ assignment: { revision: number } }>(
    "PUT",
    base + "/configuration/assignments",
    assignmentDraft,
  );
  const roleSettings = await getTemplate();
  await f.owner.ok("PUT", base + "/notification-templates/ATTENDANCE_LATE", {
    ...settings(roleSettings),
    roleIds: [role.id],
  });
  assert.equal((await inbox(manager.client)).total, 1);
  await f.owner.ok("PUT", base + "/configuration/assignments", {
    ...assignmentDraft,
    active: false,
    revision: assignment.revision,
  });
  assert.equal(
    (await inbox(manager.client)).total,
    0,
    "Removed roles must not continue to expose old notifications",
  );
  await act({ action: "complete", revision: reminder.revision });
  const completed = await own(notification.id);
  assert(completed.completedAt);
  assert.equal(completed.snoozedUntil, null);
  await emit("attendance:after-completion");
  const renewed = await inbox(subject.client);
  assert.equal(
    renewed.total,
    2,
    "A new source event can open a reason again after completion",
  );
  assert.equal(
    renewed.items.filter((row) => row.completedAt === null).length,
    1,
  );
  // Group repeated types on the server, after checking the recipient and
  // company permissions. Only the most recent message is displayed; the
  // previous completed record remains accessible in individual view.
  const grouped=await subject.client.ok<NotificationDirectory>(
    "GET",base+"/notifications?state=all&grouped=1",
  );
  assert.equal(grouped.total,1);
  assert.equal(grouped.items.length,1);
  assert.equal(grouped.items[0]?.groupCount,2);
  assert.equal(grouped.items[0]?.groupUnread,1);
  assert.equal(grouped.unreadGroups,1);
  assert.equal(grouped.items[0]?.id,renewed.items[0]?.id);
  const individual=await subject.client.ok<NotificationDirectory>(
    "GET",base+"/notifications?state=all&grouped=0&code=ATTENDANCE_LATE",
  );
  assert.equal(individual.total,2);
  assert.equal(individual.items[0]?.groupCount,1);
  assert.equal(individual.items[0]?.groupUnread,1);
  assert.equal((await subject.client.request(
    "GET",base+"/notifications?state=all&grouped=1&code=INVALID-TYPE",
  )).status,400);
  assert.equal((await peer.client.ok<NotificationDirectory>(
    "GET",base+"/notifications?state=all&grouped=1",
  )).total,1,"Only a permitted recipient's notifications are grouped");


  await subject.client.ok("POST", "/auth/password", {
    currentPassword: password,
    newPassword: "notifications-new-test-passphrase",
  });
  const publicInbox = await subject.client.ok<NotificationDirectory>(
    "GET",
    "/notifications?state=all",
  );
  assert.equal(publicInbox.total, 1);
  assert.equal(publicInbox.items[0]!.code, "AUTH_PASSWORD_CHANGED");
  assert.equal(publicInbox.items[0]!.companyId, null);
  const publicTemplates = await f.owner.ok<NotificationTemplateDirectory>(
    "GET",
    "/notification-templates",
  );
  const passwordTemplate = publicTemplates.templates.find(
    (row) => row.code === "AUTH_PASSWORD_CHANGED",
  );
  assert(passwordTemplate && !passwordTemplate.canDisable);
  assert.equal(
    (
      await f.owner.request(
        "PUT",
        "/notification-templates/AUTH_PASSWORD_CHANGED",
        {
          ...settings(passwordTemplate),
          enabled: false,
        },
      )
    ).status,
    400,
  );
  assert.equal((await inbox(subject.client)).total, 3);
  const inOtherCompany = await inbox(subject.client, "all", otherBase);
  assert.equal(inOtherCompany.total, 1);
  assert.equal(inOtherCompany.items[0]!.companyId, null);
  assert.equal(
    (await peer.client.ok<NotificationDirectory>("GET", "/notifications"))
      .total,
    0,
  );
  await f.owner.ok("PATCH", base + `/employees/${subject.employee.id}`, {
    active: false,
  });
  assert.equal(
    (await subject.client.request("GET", base + "/notifications")).status,
    403,
  );
  assert.equal(
    (await subject.client.ok<NotificationDirectory>("GET", "/notifications"))
      .total,
    1,
  );
  await assert.rejects(
    f.pool.query("DELETE FROM notifications WHERE id=$1", [notification.id]),
    (error: { code?: string }) => error.code === "23514",
  );
});

test("attendance generates only implemented, due notifications and rerunning the worker does not duplicate them", async (t) => {
  const { runAttendanceNotifications } =
    await import("../apps/api/src/services/attendance-notifications.ts");
  const f = await fixture(t);
  const company = await f.company("Automatic attendance notifications");
  const absent = await f.staff(company.id, "Absent employee");
  const missed = await f.staff(company.id, "Missing check-in employee");
  const late = await f.staff(company.id, "Late employee");
  const open = await f.staff(company.id, "Open attendance employee");
  const future = await f.staff(company.id, "Future employee");
  const base = `/companies/${company.id}`;
  const branch = (
    await f.owner.ok<Page<{ id: number }>>("GET", base + "/branches")
  ).items[0]!.id;
  const codes = [
    "ATTENDANCE_LATE",
    "ATTENDANCE_MISSED_30",
    "ATTENDANCE_ABSENT",
    "ATTENDANCE_OPEN_16H",
  ];
  const templates = await f.owner.ok<NotificationTemplateDirectory>(
    "GET",
    base + "/notification-templates",
  );
  for (const code of codes) {
    const template = templates.templates.find((row) => row.code === code);
    assert(template?.implemented);
    await f.owner.ok("PUT", base + "/notification-templates/" + code, {
      ...settings(template),
      notifyManagers: false,
      notifySubject: true,
    });
  }
  const planned = templates.templates.find(
    (row) => row.code === "ITEM_STOPPED",
  );
  assert(planned && !planned.implemented);
  assert.equal(
    (
      await f.owner.request(
        "PUT",
        base + "/notification-templates/ITEM_STOPPED",
        {
          ...settings(planned),
          enabled: true,
        },
      )
    ).status,
    400,
  );
  for (const person of [absent, late, open]) {
    await f.pool.query(
      `INSERT INTO employee_schedules(company_id,employee_id,branch_id,work_days,start_time,end_time,active,updated_by,updated_at)
      VALUES($1,$2,$3,'{0,1,2,3,4,5,6}','08:00','16:00',true,$4,clock_timestamp()-interval '2 days')`,
      [company.id, person.employee.id, branch, f.ownerUser.id],
    );
  }
  await f.pool.query(
    `INSERT INTO employee_schedules(company_id,employee_id,branch_id,work_days,start_time,end_time,active,updated_by,updated_at)
    VALUES($1,$2,$3,'{0,1,2,3,4,5,6}',
      ((clock_timestamp() AT TIME ZONE 'Asia/Aden')-interval '1 hour')::time,
      ((clock_timestamp() AT TIME ZONE 'Asia/Aden')+interval '1 hour')::time,
      true,$4,clock_timestamp()-interval '2 days')`,
    [company.id, missed.employee.id, branch, f.ownerUser.id],
  );
  // A schedule first effective tomorrow cannot infer an absence today.
  await f.pool.query(
    `INSERT INTO employee_schedules(company_id,employee_id,branch_id,work_days,start_time,end_time,active,updated_by,updated_at)
    VALUES($1,$2,$3,'{0,1,2,3,4,5,6}','08:00','16:00',true,$4,clock_timestamp()+interval '1 day')`,
    [company.id, future.employee.id, branch, f.ownerUser.id],
  );
  const clock = (
    await f.pool.query<{
      yesterday: string;
      openDay: string;
      openAt: Date;
    }>(`SELECT
    ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date-1)::text AS yesterday,
    ((clock_timestamp()-interval '17 hours') AT TIME ZONE 'Asia/Aden')::date::text AS "openDay",
    clock_timestamp()-interval '17 hours' AS "openAt"`)
  ).rows[0]!;
  await f.pool.query(
    `INSERT INTO attendance_records(company_id,employee_id,employee_name,branch_id,branch_name,work_date,checked_in_at,checked_out_at,start_time,end_time,schedule_revision,idempotency_key,created_by,updated_by)
    VALUES($1,$2,$3,$4,'Historical branch',$5,$6,$7,'08:00','16:00',1,$8,$9,$9)`,
    [
      company.id,
      late.employee.id,
      late.employee.name,
      branch,
      clock.yesterday,
      `${clock.yesterday}T08:10:00+03:00`,
      `${clock.yesterday}T16:00:00+03:00`,
      randomUUID(),
      f.ownerUser.id,
    ],
  );
  await f.pool.query(
    `INSERT INTO attendance_records(company_id,employee_id,employee_name,branch_id,branch_name,work_date,checked_in_at,start_time,end_time,schedule_revision,idempotency_key,created_by,updated_by)
    VALUES($1,$2,$3,$4,'Historical branch',$5,$6,'08:00','16:00',1,$7,$8,$8)`,
    [
      company.id,
      open.employee.id,
      open.employee.name,
      branch,
      clock.openDay,
      clock.openAt,
      randomUUID(),
      f.ownerUser.id,
    ],
  );
  await runAttendanceNotifications(f.pool);
  assert.equal(
    (await f.pool.query("SELECT count(*)::integer AS total FROM notifications"))
      .rows[0]!.total,
    0,
    "Activation must not backfill old attendance deadlines",
  );
  await f.pool.query(
    "UPDATE notification_runtime SET activated_at=clock_timestamp()-interval '3 days'",
  );
  await runAttendanceNotifications(f.pool);
  const inbox = (client: Client) =>
    client.ok<NotificationDirectory>(
      "GET",
      base + "/notifications?state=all&pageSize=100",
    );
  const absentInbox = await inbox(absent.client);
  assert(
    (await inbox(missed.client)).items.some(
      (row) => row.code === "ATTENDANCE_MISSED_30",
    ),
  );
  assert(absentInbox.items.some((row) => row.code === "ATTENDANCE_ABSENT"));
  assert(
    (await inbox(late.client)).items.some(
      (row) => row.code === "ATTENDANCE_LATE",
    ),
  );
  assert(
    (await inbox(open.client)).items.some(
      (row) => row.code === "ATTENDANCE_OPEN_16H",
    ),
  );
  assert.equal((await inbox(future.client)).total, 0);
  const before = (
    await f.pool.query<{ id: number; revision: number }>(
      "SELECT id,revision FROM notifications ORDER BY id",
    )
  ).rows;
  await Promise.all([
    runAttendanceNotifications(f.pool),
    runAttendanceNotifications(f.pool),
  ]);
  const after = (
    await f.pool.query<{ id: number; revision: number }>(
      "SELECT id,revision FROM notifications ORDER BY id",
    )
  ).rows;
  assert.deepEqual(
    after,
    before,
    "Worker retries must preserve existing notification records and revisions",
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM notifications n JOIN notification_templates t ON t.code=n.code WHERE NOT t.implemented",
      )
    ).rowCount,
    0,
  );
});

import type { PoolClient } from "pg";
import type { DeviceKind } from "./user-device-activity.ts";
import { companyExternalDesktopActivityCode, emitNotification } from "./notifications.ts";

/** Unknown/embedded agents are not assumed to be desktops just because they lack a mobile marker. */
export function isCompanyActivityDesktop(agent: string, kind: DeviceKind): boolean {
  const ua = agent.slice(0,512);
  return kind === "desktop_browser" &&
    /Windows NT|Macintosh|CrOS|X11|Linux x86_64|Ubuntu/i.test(ua) &&
    /Firefox\/|Chrome\/|Safari\/|Edg\/|OPR\/|Opera\//i.test(ua);
}

export const claimCompanyDesktopActivityAlertSql = `UPDATE company_known_devices
  SET last_owner_activity_alert_at=clock_timestamp()
  WHERE company_id=$1 AND id=$2 AND device_kind='desktop_browser' AND category<>'pharmacy'
    AND (last_owner_activity_alert_at IS NULL OR last_owner_activity_alert_at <= clock_timestamp()-interval '60 minutes')
  RETURNING last_owner_activity_alert_at::text AS "alertedAt"`;

/** Called for a fresh foreground gesture only, within discovery's company-scoped transaction. */
export async function notifyCompanyExternalDesktop(client: PoolClient, input: {
  companyId: number; deviceId: string; label: string; browser: string; os: string;
}) {
  const { companyId, deviceId } = input;
  const { rows: owners } = await client.query<{id:number}>(
    "SELECT id FROM users WHERE owner AND NOT archived AND NOT suspended LIMIT 1");
  const ownerId = owners[0]?.id;
  if (!ownerId) return;
  const claim = await client.query<{alertedAt:string}>(claimCompanyDesktopActivityAlertSql, [companyId, deviceId]);
  if (!claim.rows[0]) return;
  const streamKey = "company-device:" + deviceId;
  const eventKey = streamKey + ":active:" + claim.rows[0].alertedAt;
  const label = input.label.trim() || "DEV-" + deviceId.padStart(6,"0");
  await emitNotification(client, {
    code: companyExternalDesktopActivityCode, companyId,
    recipientUserId: ownerId, explicitSubjectOnly: true,
    subjectKey: streamKey, streamKey, eventKey,
    message: `نشاط في الشركة من ${label} (${input.browser}، ${input.os}) غير مصنف «جهاز الشركة».`,
    href: `/companies/${companyId}/approved-devices`,
  });
  // Measure the next window from the completed delivery claim, not the
  // potentially earlier start of the transaction.
  await client.query(`UPDATE company_known_devices SET last_owner_activity_alert_at=clock_timestamp()
      WHERE company_id=$1 AND id=$2`, [companyId, deviceId]);
}

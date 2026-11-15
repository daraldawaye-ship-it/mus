const groupCodes = ["CHAT_GROUP_GLOBAL", "CHAT_GROUP_COMPANY"] as const;
const directCodes = ["CHAT_DIRECT_GLOBAL", "CHAT_DIRECT_COMPANY"] as const;
type ChatCode = typeof groupCodes[number] | typeof directCodes[number];

type ClickedChatNotification = {
  id: number;
  revision: number;
  viewerId: number;
  sourceCompanyId: number | null;
  companyId: number | null;
  code: ChatCode;
};

type NotificationLink = {
  id: number;
  revision: number;
  companyId: number | null;
  code: string;
  href: string | null;
  completedAt: string | null;
};

const isPositiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function isChatCode(code: unknown): code is ChatCode {
  return code === "CHAT_GROUP_GLOBAL" || code === "CHAT_GROUP_COMPANY" ||
    code === "CHAT_DIRECT_GLOBAL" || code === "CHAT_DIRECT_COMPANY";
}

function destination(code: ChatCode, companyId: number | null) {
  if (code.endsWith("_GLOBAL")) return companyId === null ? "/chat" : null;
  return isPositiveId(companyId) ? `/companies/${companyId}/chat` : null;
}

export function notificationChatOpenState(
  record: NotificationLink,
  viewerId: number | undefined,
  sourceCompanyId: number | undefined,
) {
  if (!isPositiveId(viewerId) || !isPositiveId(record.id) ||
      !isPositiveId(record.revision) || record.completedAt ||
      !isChatCode(record.code) || record.href !== destination(record.code, record.companyId) ||
      record.href === null || (sourceCompanyId !== undefined && !isPositiveId(sourceCompanyId)) ||
      (record.companyId !== null && record.companyId !== sourceCompanyId)) return undefined;
  return { clickedChatNotification: {
    id: record.id, revision: record.revision, viewerId,
    companyId: record.companyId, sourceCompanyId: sourceCompanyId ?? null, code: record.code,
  } satisfies ClickedChatNotification };
}

export function notificationChatCompletion(
  state: unknown,
  viewerId: number,
  pathname: string,
  navigationType: string,
): (ClickedChatNotification & { kind: "group" | "direct" }) | undefined {
  // Browser history restores Link state on back/reload; that is not a new click.
  if ((navigationType !== "PUSH" && navigationType !== "REPLACE") ||
      !state || typeof state !== "object" || !("clickedChatNotification" in state)) return;
  const raw = state.clickedChatNotification;
  if (!raw || typeof raw !== "object") return;
  const value = raw as Partial<ClickedChatNotification>;
  const {id, revision, viewerId: actor, companyId, sourceCompanyId, code} = value;
  if (actor !== viewerId || !isPositiveId(id) || !isPositiveId(revision) ||
      !isChatCode(code) || (companyId !== null && !isPositiveId(companyId)) ||
      (sourceCompanyId !== null && !isPositiveId(sourceCompanyId)) ||
      (companyId !== null && companyId !== sourceCompanyId) ||
      pathname !== destination(code, companyId)) return;
  return {id, revision, viewerId: actor, companyId, sourceCompanyId, code,
    kind: code.startsWith("CHAT_GROUP_") ? "group" : "direct"};
}

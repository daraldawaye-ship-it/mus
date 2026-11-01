import type { Item } from "../../../../packages/contracts/src/index.ts";

/**
 * Changing any of the three fields is one event per committed item revision.
 * Distinguish a newly eligible item from a removed one, including edits that
 * move an existing period into or out of today's company-local date.
 */
export type ItemClearanceSettings = Pick<Item,
  "commissionRate" | "clearanceFrom" | "clearanceTo">;

export type ClearanceNoticeCode =
  "ITEM_CLEARANCE_ADDED" | "ITEM_CLEARANCE_UPDATED" | "ITEM_CLEARANCE_REMOVED";

function configured(value: ItemClearanceSettings): boolean {
  return Number(value.commissionRate) > 0 &&
    !!value.clearanceFrom && !!value.clearanceTo &&
    value.clearanceFrom <= value.clearanceTo;
}
function activeToday(value: ItemClearanceSettings, today: string): boolean {
  return configured(value) &&
    value.clearanceFrom! <= today && today <= value.clearanceTo!;
}
export function adenDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function classifyClearanceChange(
  before: ItemClearanceSettings, after: ItemClearanceSettings, today: string,
): ClearanceNoticeCode | null {
  if (before.commissionRate === after.commissionRate &&
      before.clearanceFrom === after.clearanceFrom &&
      before.clearanceTo === after.clearanceTo) return null;
  const wasConfigured = configured(before), isConfigured = configured(after);
  const wasActive = activeToday(before, today), isActive = activeToday(after, today);
  if ((!wasConfigured && isConfigured) || (!wasActive && isActive))
    return "ITEM_CLEARANCE_ADDED";
  if ((wasConfigured && !isConfigured) || (wasActive && !isActive))
    return "ITEM_CLEARANCE_REMOVED";
  return "ITEM_CLEARANCE_UPDATED";
}
const titles: Record<ClearanceNoticeCode, string> = {
  ITEM_CLEARANCE_ADDED: "إضافة صنف إلى التصريف",
  ITEM_CLEARANCE_UPDATED: "تعديل تصريف صنف",
  ITEM_CLEARANCE_REMOVED: "إخراج صنف من التصريف",
};
const shown = (value: string | null) => value || "غير محدد";
export function itemClearanceNotice(
  before: ItemClearanceSettings,
  after: ItemClearanceSettings,
  item: Pick<Item, "id" | "name" | "code" | "revision">,
  actorName: string,
  today: string = adenDate(),
): { code: ClearanceNoticeCode; title: string; message: string;
     eventKey: string; subjectKey: string } | null {
  const code = classifyClearanceChange(before, after, today);
  if (!code) return null;
  const changes: string[] = [];
  if (before.commissionRate !== after.commissionRate)
    changes.push(`النسبة: ${before.commissionRate}% ← ${after.commissionRate}%`);
  if (before.clearanceFrom !== after.clearanceFrom)
    changes.push(`من: ${shown(before.clearanceFrom)} ← ${shown(after.clearanceFrom)}`);
  if (before.clearanceTo !== after.clearanceTo)
    changes.push(`إلى: ${shown(before.clearanceTo)} ← ${shown(after.clearanceTo)}`);
  return {
    code, title: titles[code],
    subjectKey: `item:${item.id}`,
    eventKey: `item:clearance:${item.id}:revision:${item.revision}`,
    message: `الصنف «${item.name}» (رمز ${item.code}). المستخدم: ${actorName}. ${changes.join("؛ ")}.`,
  };
}

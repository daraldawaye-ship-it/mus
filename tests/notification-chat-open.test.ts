import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { notificationChatCompletion, notificationChatOpenState } from "../apps/web/src/notification-chat-open.ts";

const common = {id: 81, revision: 2, completedAt: null};

test("only a clicked group or direct chat alert carries its exact completion target", () => {
  const cases = [
    ["CHAT_GROUP_GLOBAL", null, undefined, "/chat", "group"],
    ["CHAT_DIRECT_GLOBAL", null, 2, "/chat", "direct"],
    ["CHAT_GROUP_COMPANY", 2, 2, "/companies/2/chat", "group"],
    ["CHAT_DIRECT_COMPANY", 7, 7, "/companies/7/chat", "direct"],
  ] as const;
  for (const [code, companyId, source, href, kind] of cases) {
    const state = notificationChatOpenState({...common, code, companyId, href}, 5, source);
    assert.deepEqual(notificationChatCompletion(state, 5, href, "PUSH"),
      {id: 81, revision: 2, viewerId: 5, sourceCompanyId: source ?? null, companyId, code, kind});
    assert.equal(notificationChatCompletion(state, 5, href, "REPLACE")?.id, 81);
    assert.equal(notificationChatCompletion(state, 5, href, "POP"), undefined);
    assert.equal(notificationChatCompletion(state, 6, href, "PUSH"), undefined);
    assert.equal(notificationChatCompletion(state, 5, "/notifications", "PUSH"), undefined);
  }
});

test("non-chat, completed and mismatched notification links retain existing behavior", () => {
  const record = {...common, code: "CHAT_GROUP_COMPANY", companyId: 2, href: "/companies/2/chat"};
  for (const item of [
    {...record, code: "QUICK_SYSTEM_CHANGE"},
    {...record, code: "CHAT_GROUP_GLOBAL", companyId: null, href: "//example.com/chat"},
    {...record, href: null},
    {...record, completedAt: "2026-11-15T12:30:00Z"},
    {...record, companyId: 3},
  ]) assert.equal(notificationChatOpenState(item, 5, 2), undefined);
  assert.equal(notificationChatCompletion({clickedChatNotification: {
    ...common, viewerId: 5, code: "CHAT_GROUP_COMPANY", companyId: 2, sourceCompanyId: 3,
  }}, 5, record.href, "PUSH"), undefined);
  assert.equal(notificationChatCompletion(undefined, 5, record.href, "PUSH"), undefined);
});

test("every alert link forwards the exact target to the authorized chat, not the generic shortcut", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const bell = read("../apps/web/src/NotificationBell.tsx");
  const inbox = read("../apps/web/src/pages/NotificationsPage.tsx");
  const chat = read("../apps/web/src/pages/ChatPage.tsx");
  assert.match(bell, /to=\{headsUp.href\} state=\{headsUp.openState\}/);
  assert.equal((bell.match(/state=\{notificationChatOpenState\(record, user\?\.id, record\.companyId \?\? undefined\)\}/g) ?? []).length, 2);
  assert.match(bell, /to=\{\x60\$\{base\}\/chat\x60\} onClick=\{close\}/);
  assert.match(inbox, /to=\{record.href\} state=\{notificationChatOpenState\(record, user\?\.id, companyId\)\}/);
  assert.match(chat, /if \(!clicked \|\| !\(clicked.kind === "group" \? groups.isSuccess : conversations.isSuccess\)\) return;/);
  assert.match(chat, /if \(attemptedNotification.current === attempt\) return;/);
  assert.match(chat, /body: \{ action: "complete", revision: clicked.revision \}/);
});

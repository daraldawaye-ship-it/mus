import assert from "node:assert/strict";
import test from "node:test";
import { readRecentEntity, rememberRecentEntity, RECENT_ENTITY_EVENT } from "../apps/web/src/recent-entities.ts";

test("last item/account/employee stays isolated by user and company", () => {
  const snapshot = Object.getOwnPropertyDescriptor(globalThis, "window");
  const store = new Map<string,string>();
  const events: string[] = [];
  const mockWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
    dispatchEvent: (event: CustomEvent<{kind:string}>) => { events.push(event.type + ":" + event.detail.kind);return true; },
  };
  Object.defineProperty(globalThis, "window", {value:mockWindow,configurable:true});
  try {
    assert.equal(readRecentEntity(1, 10, "item"), null);
    rememberRecentEntity(1, 10, "item", {id:20,name:"دواء واحد"});
    rememberRecentEntity(1, 10, "account", {id:4,name:"عميل"});
    rememberRecentEntity(1, 11, "item", {id:30,name:"دواء آخر"});
    rememberRecentEntity(2, 10, "employee", {id:7,name:"موظف"});
    assert.deepEqual(readRecentEntity(1, 10, "item"), {id:20,name:"دواء واحد"});
    assert.deepEqual(readRecentEntity(1, 11, "item"), {id:30,name:"دواء آخر"});
    assert.equal(readRecentEntity(2, 10, "item"), null);
    assert.equal(readRecentEntity(1, 10, "employee"), null);
    assert.deepEqual(readRecentEntity(1, 10, "account"), {id:4,name:"عميل"});
    rememberRecentEntity(1, 10, "item", {id:21,name:"دواء جديد"});
    assert.deepEqual(readRecentEntity(1, 10, "item"), {id:21,name:"دواء جديد"});
    assert(events.includes(RECENT_ENTITY_EVENT + ":item"));
    rememberRecentEntity(1, 10, "item", {id:-1,name:"غير صالح"});
    assert.equal(readRecentEntity(1, 10, "item")?.id, 21);
    store.set("alraesy:recent:1:10:employee", "{bad");
    assert.equal(readRecentEntity(1, 10, "employee"), null);
  } finally {
    if (snapshot) Object.defineProperty(globalThis, "window", snapshot);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

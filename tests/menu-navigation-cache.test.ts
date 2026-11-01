import assert from "node:assert/strict";
import test from "node:test";
import type { PageEntry } from "../packages/contracts/src/index.ts";
import {
  buildMenuNavigation, readMenuNavigation, saveMenuNavigation,
} from "../apps/web/src/menu-navigation-cache.ts";

const page = (
  key: string, href: string, order: number, options: {
    view?: boolean; enabled?: boolean; create?: boolean; scope?: "company" | "public";
  } = {},
): PageEntry => ({
  key, href, name: key, order,
  enabled: options.enabled ?? true,
  scope: options.scope ?? "company",
  record: false,
  actionAccess: { view: options.view ?? true, create: options.create ?? false },
} as PageEntry);
const user = {id: 43, owner: false, kind: "member"} as const;

test("snapshot includes only previously permitted company links in catalog order", () => {
  const pages = [
    page("company.pages", "/companies/2/pages", 0),
    page("company.sales", "/companies/2/sales", 3),
    page("company.items", "/companies/2/items", 2),
    page("company.admin", "/companies/2/control", 4, {view: false}),
    page("company.disabled", "/companies/2/disabled", 5, {enabled: false}),
    page("company.external", "https://example.com", 6),
  ];
  const snapshot = buildMenuNavigation(user, 2, pages,
    ["company.sales", "company.items", "company.sales", "company.admin",
      "company.disabled", "company.external"]);
  assert.equal(snapshot.defaultHref, "/companies/2/pages");
  assert.deepEqual(snapshot.links.map(link => link.key), ["company.items", "company.sales"]);
  assert.deepEqual(snapshot.tabs, ["navigation", "item", "settings"]);
});

test("snapshots are scoped per account/company and expire with offline identity", () => {
  const stored = new Map<string, string>();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {configurable: true, value: {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    },
  }});
  try {
    const pages = [page("company.pages", "/companies/2/pages", 0),
      page("company.sales", "/companies/2/sales", 1)];
    saveMenuNavigation(user, 2, pages, ["company.sales"]);
    assert.deepEqual(readMenuNavigation(43, 2)?.links.map(link => link.key), ["company.sales"]);
    assert.equal(readMenuNavigation(43, 3), null);
    assert.equal(readMenuNavigation(44, 2), null);
    const valid = readMenuNavigation(43, 2)!;
    assert.equal(readMenuNavigation(43, 2, valid.savedAt + 8 * 86400000), null);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("the snapshot never grants a link not present in the authorized page catalog", () => {
  const snapshot = buildMenuNavigation(user, 2, [
    page("company.pages", "/companies/2/pages", 0),
    page("company.sales", "/companies/2/sales", 1, {view: false}),
  ], ["company.sales", "company.unknown"]);
  assert.deepEqual(snapshot.links, []);
});

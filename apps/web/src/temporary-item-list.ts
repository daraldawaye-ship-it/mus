import { useCallback, useEffect, useState } from "react";

/** Private per-user, per-company working lists. No stock or item-card mutation. */
export type TemporaryChosenItem = { id: number; name: string; code: string };
export type TemporaryListKind = "selected" | "order";
const EVENT = "alraesy-temporary-items-changed";
const MAX_ITEMS = 5000;

function storageKey(companyId: number, userId: number | string | undefined, kind: TemporaryListKind) {
  return userId == null ? null : `alraesy:temporary-items:v1:${userId}:${companyId}:${kind}`;
}

function readItems(key: string | null): TemporaryChosenItem[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    const unique = new Set<number>();
    return value.filter((row): row is TemporaryChosenItem =>
      !!row && typeof row === "object" &&
      Number.isSafeInteger(row.id) && row.id > 0 &&
      typeof row.name === "string" && typeof row.code === "string" &&
      row.name.length <= 500 && row.code.length <= 100 &&
      !unique.has(row.id) && !!unique.add(row.id)).slice(0, MAX_ITEMS);
  } catch { return []; }
}

export function useTemporaryItemList(
  companyId: number, userId: number | string | undefined, kind: TemporaryListKind,
) {
  const key = storageKey(companyId, userId, kind);
  const [items, setItems] = useState<TemporaryChosenItem[]>(() => readItems(key));
  const [error, setError] = useState("");
  useEffect(() => {
    setItems(readItems(key));
    setError("");
    if (!key) return;
    function refresh(event: Event) {
      if (event.type === "storage") {
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== key && storageEvent.key !== null) return;
      } else if ((event as CustomEvent<string>).detail !== key) return;
      setItems(readItems(key));
    }
    window.addEventListener("storage", refresh);
    window.addEventListener(EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(EVENT, refresh);
    };
  }, [key]);

  const mutate = useCallback((update: (before: TemporaryChosenItem[]) => TemporaryChosenItem[]) => {
    if (!key) return false;
    try {
      const next = update(readItems(key)).slice(0, MAX_ITEMS);
      window.localStorage.setItem(key, JSON.stringify(next));
      setItems(next);
      setError("");
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
      return true;
    } catch {
      setError("تعذر حفظ الاختيارات على الجهاز. تحقق من مساحة التخزين وأذونات المتصفح.");
      return false;
    }
  }, [key]);

  const toggle = useCallback((item: TemporaryChosenItem, checked: boolean) =>
    mutate(before => checked
      ? (before.some(entry => entry.id === item.id) ? before : [...before, item])
      : before.filter(entry => entry.id !== item.id)), [mutate]);

  const addMany = useCallback((incoming: TemporaryChosenItem[]) =>
    mutate(before => {
      const existing = new Set(before.map(item => item.id));
      const next = [...before];
      for (const item of incoming) {
        if (existing.has(item.id) || next.length >= MAX_ITEMS) continue;
        next.push(item);
        existing.add(item.id);
      }
      return next;
    }), [mutate]);

  // Bulk additions must be all-or-nothing. The ordinary addMany operation
  // may skip items at its storage limit, which must never happen for a
  // company-wide filtered draft action.
  const addManyExact = useCallback((incoming: TemporaryChosenItem[]) => {
    if (!key) return false;
    try {
      const before = readItems(key);
      const seen = new Set(before.map(item => item.id));
      const next = [...before];
      for (const item of incoming) {
        if (seen.has(item.id)) continue;
        if (next.length >= MAX_ITEMS) {
          setError(`سعة مسودة الطلبية ${MAX_ITEMS} صنف. احذف من المسودة بعض الأصناف أو ضيّق الفلتر؛ لم يُضف أي صنف من الدفعة.`);
          return false;
        }
        seen.add(item.id);
        next.push(item);
      }
      window.localStorage.setItem(key, JSON.stringify(next));
      setItems(next);
      setError("");
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
      return true;
    } catch {
      setError("تعذر حفظ جميع الأصناف على هذا الجهاز. لم تُحفظ دفعة جزئية؛ تحقق من مساحة التخزين.");
      return false;
    }
  }, [key]);

  const clear = useCallback(() => mutate(() => []), [mutate]);
  return { items, toggle, addMany, addManyExact, clear, error, enabled: !!key };
}

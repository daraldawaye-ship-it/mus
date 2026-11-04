import { useCallback, useEffect, useState } from "react";
import type { TemporaryChosenItem } from "./temporary-item-list";
import {
  createNumberedOrderDraft, emptyOrderDraftState, migrateLegacyOrderDraft,
  normalizeOrderDrafts, removeNumberedOrderDraft, removeNumberedOrderDraftItem,
  type NumberedOrderDraftState, ORDER_DRAFT_LIFETIME_MS,
} from "./numbered-order-drafts-core";

const EVENT = "alraesy-numbered-order-drafts-changed";

function draftKey(companyId: number, userId: number | string | undefined) {
  return userId == null ? null : `alraesy:order-drafts:v2:${userId}:${companyId}`;
}
function legacyKey(companyId: number, userId: number | string | undefined) {
  return userId == null ? null : `alraesy:temporary-items:v1:${userId}:${companyId}:order`;
}

function readOrderDrafts(key: string | null, legacy: string | null): NumberedOrderDraftState {
  if (!key || typeof window === "undefined") return emptyOrderDraftState();
  try {
    const saved = window.localStorage.getItem(key);
    if (saved !== null) return normalizeOrderDrafts(JSON.parse(saved) as unknown);
    // Upgrade the pre-existing one-draft UI without losing its saved lines.
    const prior = legacy ? window.localStorage.getItem(legacy) : null;
    return prior === null ? emptyOrderDraftState()
      : migrateLegacyOrderDraft(JSON.parse(prior) as unknown);
  } catch {
    return emptyOrderDraftState();
  }
}

/** Persist sanitized state, removing expired drafts and stamping older drafts
 * when the original creation timestamp was not recorded. An empty v2 state
 * prevents legacy v1 backup from reappearing after expiry. */
function refreshOrderDrafts(key: string | null, oldKey: string | null): NumberedOrderDraftState {
  const next = readOrderDrafts(key, oldKey);
  if (!key || typeof window === "undefined") return next;
  const serialized = JSON.stringify(next);
  try {
    if (window.localStorage.getItem(key) !== serialized)
      window.localStorage.setItem(key, serialized);
  } catch { /* Read remains available if a device store is full or blocked. */ }
  return next;
}

export function useNumberedOrderDrafts(
  companyId: number, userId: number | string | undefined,
) {
  const key = draftKey(companyId, userId);
  const oldKey = legacyKey(companyId, userId);
  const [state, setState] = useState<NumberedOrderDraftState>(
    () => readOrderDrafts(key, oldKey));
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    const refreshCurrent = () => setState(refreshOrderDrafts(key, oldKey));
    refreshCurrent();
    if (!key) return;

    function onStorage(event: StorageEvent) {
      if (event.key !== key && event.key !== null) return;
      refreshCurrent();
    }
    function onDraftEvent(event: Event) {
      if ((event as CustomEvent<string>).detail !== key) return;
      refreshCurrent();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") refreshCurrent();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onDraftEvent);
    window.addEventListener("focus", refreshCurrent);
    document.addEventListener("visibilitychange", onVisibility);
    // Browser timers can be throttled in background tabs; refresh on resume,
    // so expired drafts cease excluding order candidates immediately.
    const interval = window.setInterval(refreshCurrent, 60_000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onDraftEvent);
      window.removeEventListener("focus", refreshCurrent);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [key, oldKey]);

  useEffect(() => {
    if (!key || !state.drafts.length) return;
    const nextExpiry = Math.min(...state.drafts.map(draft =>
      Date.parse(draft.createdAt) + ORDER_DRAFT_LIFETIME_MS));
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, Math.min(2_147_483_647, nextExpiry - Date.now() + 40));
    const timer = window.setTimeout(() => {
      setState(refreshOrderDrafts(key, oldKey));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [key, oldKey, state.drafts]);

  const save = useCallback((next: NumberedOrderDraftState) => {
    if (!key) return false;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      setState(next);
      setError("");
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
      return true;
    } catch {
      setError("تعذر حفظ مسودة الطلبية كاملة على هذا الجهاز. لم تُنشأ مسودة جزئية؛ راجع مساحة التخزين.");
      return false;
    }
  }, [key]);

  const createDraft = useCallback((incoming: TemporaryChosenItem[]) => {
    if (!key) return null;
    const before = readOrderDrafts(key, oldKey);
    const created = createNumberedOrderDraft(before, incoming);
    if (created.error) {
      setError(created.error);
      return null;
    }
    if (!created.id) {
      setError("");
      return { id: null, added: 0, skipped: created.skipped };
    }
    if (!save(created.state)) return null;
    return { id: created.id, added: created.added, skipped: created.skipped };
  }, [key, oldKey, save]);

  const deleteDraft = useCallback((draftId: number) => {
    if (!key) return false;
    const before = readOrderDrafts(key, oldKey);
    if (!before.drafts.some(draft => draft.id === draftId)) return false;
    return save(removeNumberedOrderDraft(before, draftId));
  }, [key, oldKey, save]);

  const removeItem = useCallback((draftId: number, itemId: number) => {
    if (!key) return false;
    const before = readOrderDrafts(key, oldKey);
    if (!before.drafts.some(draft => draft.id === draftId &&
      draft.items.some(item => item.id === itemId))) return false;
    return save(removeNumberedOrderDraftItem(before, draftId, itemId));
  }, [key, oldKey, save]);

  return { drafts: state.drafts, createDraft, deleteDraft, removeItem,
    error, enabled: !!key };
}

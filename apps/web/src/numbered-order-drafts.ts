import { useCallback, useEffect, useState } from "react";
import type { TemporaryChosenItem } from "./temporary-item-list";
import {
  createNumberedOrderDraft, emptyOrderDraftState, migrateLegacyOrderDraft,
  normalizeOrderDrafts, removeNumberedOrderDraft, removeNumberedOrderDraftItem,
  type NumberedOrderDraftState,
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

export function useNumberedOrderDrafts(
  companyId: number, userId: number | string | undefined,
) {
  const key = draftKey(companyId, userId);
  const oldKey = legacyKey(companyId, userId);
  const [state, setState] = useState<NumberedOrderDraftState>(
    () => readOrderDrafts(key, oldKey));
  const [error, setError] = useState("");

  useEffect(() => {
    setState(readOrderDrafts(key, oldKey));
    setError("");
    if (!key) return;
    // Migration is copy-once; keep the old data untouched as a backup.
    try {
      if (window.localStorage.getItem(key) === null) {
        const migrated = readOrderDrafts(key, oldKey);
        if (migrated.drafts.length)
          window.localStorage.setItem(key, JSON.stringify(migrated));
      }
    } catch {
      setError("تعذرت تهيئة مسودات الطلبيات المحلية؛ تحقق من مساحة تخزين الجهاز.");
    }
    function refresh(event: Event) {
      if (event.type === "storage") {
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== key && storageEvent.key !== null) return;
      } else if ((event as CustomEvent<string>).detail !== key) return;
      setState(readOrderDrafts(key, oldKey));
    }
    window.addEventListener("storage", refresh);
    window.addEventListener(EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(EVENT, refresh);
    };
  }, [key, oldKey]);

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

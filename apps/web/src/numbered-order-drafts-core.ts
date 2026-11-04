import type { TemporaryChosenItem } from "./temporary-item-list";

// Drafts belong only to this user's browser. Nothing here posts invoices/orders.
export type NumberedOrderDraft = { id: number; items: TemporaryChosenItem[] };
export type NumberedOrderDraftState = { nextId: number; drafts: NumberedOrderDraft[] };
export const MAX_NEW_ORDER_DRAFT_ITEMS = 2_000;

export const emptyOrderDraftState = (): NumberedOrderDraftState =>
  ({ nextId: 1, drafts: [] });

function validItem(value: unknown): value is TemporaryChosenItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TemporaryChosenItem>;
  return Number.isSafeInteger(row.id) && (row.id ?? 0) > 0
    && typeof row.name === "string" && row.name.length <= 500
    && typeof row.code === "string" && row.code.length <= 100;
}

function uniqueItems(source: unknown, global: Set<number>, limit: number): TemporaryChosenItem[] {
  if (!Array.isArray(source)) return [];
  const rows: TemporaryChosenItem[] = [];
  for (const row of source) {
    if (!validItem(row) || global.has(row.id)) continue;
    global.add(row.id);
    rows.push({ id: row.id, name: row.name, code: row.code });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Repairs old/corrupt stored duplicates across drafts while preserving the first owner. */
export function normalizeOrderDrafts(value: unknown): NumberedOrderDraftState {
  if (!value || typeof value !== "object") return emptyOrderDraftState();
  const source = value as Partial<NumberedOrderDraftState>;
  if (!Array.isArray(source.drafts)) return emptyOrderDraftState();
  const seenItemIds = new Set<number>();
  const seenDraftIds = new Set<number>();
  const drafts: NumberedOrderDraft[] = [];
  for (const draft of source.drafts) {
    if (!draft || !Number.isSafeInteger(draft.id) || draft.id < 1 ||
        seenDraftIds.has(draft.id)) continue;
    seenDraftIds.add(draft.id);
    // Existing v1 draft may contain up to 5000 lines; never discard on upgrade.
    const items = uniqueItems(draft.items, seenItemIds, 5_000);
    drafts.push({ id: draft.id, items });
  }
  const highest = drafts.reduce((max, draft) => Math.max(max, draft.id), 0);
  const storedNext = Number.isSafeInteger(source.nextId) && (source.nextId ?? 0) > 0
    ? source.nextId! : 1;
  return { nextId: Math.max(highest + 1, storedNext), drafts };
}

/** Import v1's sole local order draft as draft 1; leave legacy key untouched. */
export function migrateLegacyOrderDraft(legacy: unknown): NumberedOrderDraftState {
  const items = uniqueItems(legacy, new Set<number>(), 5_000);
  return items.length
    ? { nextId: 2, drafts: [{ id: 1, items }] }
    : emptyOrderDraftState();
}

export type CreateOrderDraftResult = {
  state: NumberedOrderDraftState;
  id: number | null;
  added: number;
  skipped: number;
  error: string | null;
};

/** Never append to an old draft. Create a new numbered draft per successful transfer. */
export function createNumberedOrderDraft(
  rawState: NumberedOrderDraftState, incoming: TemporaryChosenItem[],
): CreateOrderDraftResult {
  const state = normalizeOrderDrafts(rawState);
  const alreadyInDrafts = new Set(state.drafts.flatMap(draft => draft.items.map(item => item.id)));
  const items = uniqueItems(incoming, alreadyInDrafts, MAX_NEW_ORDER_DRAFT_ITEMS + 1);
  const skipped = incoming.length - items.length;
  if (items.length > MAX_NEW_ORDER_DRAFT_ITEMS) return {
    state, id: null, added: 0, skipped,
    error: "الحد الأقصى 2000 صنف في المسودة الجديدة. ضيّق الفلتر؛ لم تُحفظ مسودة جزئية.",
  };
  if (!items.length) return { state, id: null, added: 0, skipped, error: null };
  if (!Number.isSafeInteger(state.nextId) || state.nextId >= Number.MAX_SAFE_INTEGER) return {
    state, id: null, added: 0, skipped,
    error: "تعذر إنشاء رقم جديد للمسودة؛ لم تُجر أي إضافة.",
  };
  const id = state.nextId;
  return {
    state: { nextId: id + 1, drafts: [...state.drafts, { id, items }] },
    id, added: items.length, skipped, error: null,
  };
}

export function removeNumberedOrderDraft(
  state: NumberedOrderDraftState, draftId: number,
): NumberedOrderDraftState {
  return { ...state, drafts: state.drafts.filter(draft => draft.id !== draftId) };
}

export function removeNumberedOrderDraftItem(
  state: NumberedOrderDraftState, draftId: number, itemId: number,
): NumberedOrderDraftState {
  return { ...state, drafts: state.drafts.map(draft => draft.id === draftId
    ? { ...draft, items: draft.items.filter(item => item.id !== itemId) }
    : draft) };
}

import type { TemporaryChosenItem } from "./temporary-item-list";

// Drafts belong only to this user's browser. Nothing here posts invoices/orders.
/** A stored quantity is a first-unit planning snapshot from the API. */
export type OrderDraftItem = TemporaryChosenItem & {
  requiredQuantity?: string;
  sourceOptionName?: string;
  deleted?: boolean;
};
export type NumberedOrderDraft = {
  id: number; createdAt: string; items: OrderDraftItem[];
  sourceOptionName?: string;
};
export const ORDER_DRAFT_LIFETIME_MS = 8 * 60 * 60 * 1000;
export type NumberedOrderDraftState = { nextId: number; drafts: NumberedOrderDraft[] };
export const MAX_NEW_ORDER_DRAFT_ITEMS = 2_000;

export const emptyOrderDraftState = (): NumberedOrderDraftState =>
  ({ nextId: 1, drafts: [] });

function validItem(value: unknown): value is OrderDraftItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TemporaryChosenItem>;
  return Number.isSafeInteger(row.id) && (row.id ?? 0) > 0
    && typeof row.name === "string" && row.name.length <= 500
    && typeof row.code === "string" && row.code.length <= 100;
}

function uniqueItems(source: unknown, global: Set<number>, limit: number): OrderDraftItem[] {
  if (!Array.isArray(source)) return [];
  const rows: OrderDraftItem[] = [];
  for (const row of source) {
    if (!validItem(row) || global.has(row.id)) continue;
    global.add(row.id);
    // Never lose the saved quantity during normalization or 8-hour cleanup.
    // Older drafts have no quantity; leave those alone rather than inventing one.
    const requiredQuantity = typeof row.requiredQuantity === "string"
      && /^[1-9]\d{0,15}$/.test(row.requiredQuantity)
      ? row.requiredQuantity : undefined;
    const sourceOptionName = typeof row.sourceOptionName === "string"
      ? row.sourceOptionName.trim().slice(0, 80) : "";
    rows.push({ id: row.id, name: row.name, code: row.code,
      ...(requiredQuantity ? { requiredQuantity } : {}),
      ...(sourceOptionName ? { sourceOptionName } : {}),
      ...(row.deleted === true ? { deleted: true } : {}) });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Repairs old/corrupt stored duplicates across drafts while preserving the first owner. */
export function normalizeOrderDrafts(value: unknown, now = Date.now()): NumberedOrderDraftState {
  if (!value || typeof value !== "object") return emptyOrderDraftState();
  const source = value as Partial<NumberedOrderDraftState>;
  if (!Array.isArray(source.drafts)) return emptyOrderDraftState();
  const seenItemIds = new Set<number>();
  let highestSeenId = 0;
  const seenDraftIds = new Set<number>();
  const drafts: NumberedOrderDraft[] = [];
  for (const draft of source.drafts) {
    if (!draft || !Number.isSafeInteger(draft.id) || draft.id < 1 ||
        seenDraftIds.has(draft.id)) continue;
    seenDraftIds.add(draft.id);
    highestSeenId = Math.max(highestSeenId, draft.id);
    // Previously saved drafts have no creation timestamp; start their first
    // eight-hour window at migration, rather than deleting them arbitrarily.
    const rawTime = typeof draft.createdAt === "string"
      ? Date.parse(draft.createdAt) : NaN;
    const createdMs = Number.isFinite(rawTime) && rawTime > 0 && rawTime <= now
      ? rawTime : now;
    if (createdMs + ORDER_DRAFT_LIFETIME_MS <= now) continue;
    // Existing v1 draft may contain up to 5000 lines; never discard on upgrade.
    const items = uniqueItems(draft.items, seenItemIds, 5_000);
    const sourceOptionName = typeof draft.sourceOptionName === "string"
      ? draft.sourceOptionName.trim().slice(0, 80) : "";
    drafts.push({ id: draft.id, createdAt: new Date(createdMs).toISOString(), items,
      ...(sourceOptionName ? { sourceOptionName } : {}) });
  }
  const highest = highestSeenId;
  const storedNext = Number.isSafeInteger(source.nextId) && (source.nextId ?? 0) > 0
    ? source.nextId! : 1;
  return { nextId: Math.max(highest + 1, storedNext), drafts };
}

/** Import v1's sole local order draft as draft 1; leave legacy key untouched. */
export function migrateLegacyOrderDraft(legacy: unknown, now = Date.now()): NumberedOrderDraftState {
  const items = uniqueItems(legacy, new Set<number>(), 5_000);
  return items.length
    ? { nextId: 2, drafts: [{ id: 1, createdAt: new Date(now).toISOString(), items }] }
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
  rawState: NumberedOrderDraftState, incoming: OrderDraftItem[], now = Date.now(),
  sourceOptionName?: string,
): CreateOrderDraftResult {
  const state = normalizeOrderDrafts(rawState, now);
  const alreadyInDrafts = new Set(state.drafts.flatMap(draft => draft.items.map(item => item.id)));
  const label = sourceOptionName?.trim().slice(0, 80);
  const items = uniqueItems(incoming.map(item => ({
    ...item, ...(label ? { sourceOptionName: label } : {}),
  })), alreadyInDrafts, MAX_NEW_ORDER_DRAFT_ITEMS + 1);
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
    state: { nextId: id + 1, drafts: [...state.drafts, {
      id, createdAt: new Date(now).toISOString(), items,
      ...(label ? { sourceOptionName: label } : {}),
    }] },
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

/** Soft deletion leaves the original item and its provenance available for restoring.
 * The item continues reserving its ID across drafts to prevent duplicates. */
export function setOrderDraftItemDeleted(
  state: NumberedOrderDraftState, draftId: number, itemId: number, deleted: boolean,
): NumberedOrderDraftState {
  return { ...state, drafts: state.drafts.map(draft => draft.id === draftId
    ? { ...draft, items: draft.items.map(item => item.id === itemId
      ? { ...item, ...(deleted ? { deleted: true } : { deleted: undefined }) } : item) }
    : draft) };
}

/** Edit first-unit quantity without changing other draft records or timestamps. */
export function setOrderDraftItemQuantity(
  state: NumberedOrderDraftState, draftId: number, itemId: number, quantity: string,
): NumberedOrderDraftState {
  if (!/^[1-9]\d{0,15}$/.test(quantity)) return state;
  return { ...state, drafts: state.drafts.map(draft => draft.id === draftId
    ? { ...draft, items: draft.items.map(item => item.id === itemId
      ? { ...item, requiredQuantity: quantity } : item) }
    : draft) };
}

/** A saved ordered filter group replaces ALL device drafts, not appends.
 * Build every draft in memory, then persist once; if a stage is invalid,
 * browser storage fails or no stage matches, old drafts remain untouched.
 */
export function buildReplacementOrderDrafts(
  stages: OrderDraftItem[][], now=Date.now(), sourceOptionNames: string[] = [],
): {state:NumberedOrderDraftState|null; error:string|null; added:number; skipped:number} {
  if(!stages.length || stages.length>20) return {
    state:null,error:"حدّد من 1 إلى 20 مجموعة خيارات بترتيبها",added:0,skipped:0,
  };
  let state=emptyOrderDraftState(), added=0, skipped=0;
  for(const [index, items] of stages.entries()){
    const stage=createNumberedOrderDraft(state,items,now,sourceOptionNames[index]);
    if(stage.error) return {state:null,error:stage.error,added:0,skipped:0};
    state=stage.state;
    added+=stage.added;
    skipped+=stage.skipped;
  }
  if(!state.drafts.length) return {
    state:null,error:"لا توجد أصناف مطابقة لأي مجموعة؛ لم تُحذف المسودات الحالية",
    added:0,skipped,
  };
  return {state,error:null,added,skipped};
}

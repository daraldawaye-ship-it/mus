import {
  ITEM_FACTOR_MAX, itemFactorSchema, itemFieldPatchSchema,
  itemMinOrderQuantitySchema, itemOrderAlertQuantitySchema, itemWholeQuantitySchema,
  normalizeDigits, type Item,
} from "../../../packages/contracts/src/index";

export const compactNumericFields = [
  { key:"reserveQuantity", label:"كمية احتياط", min:0n, max:10n ** 22n - 1n, hint:"بأصغر وحدة مفعّلة" },
  { key:"purchaseFactor", label:"عامل وحدة الشراء", min:1n, max:BigInt(ITEM_FACTOR_MAX), hint:"عامل الشراء المحفوظ" },
  { key:"minOrderQuantity", label:"أقل كمية طلب", min:1n, max:2147483647n, hint:"حد الحساب التلقائي بالوحدة الأولى" },
  { key:"orderAlertQuantity", label:"كمية الطلب", min:0n, max:10n ** 22n - 1n, hint:"التنبيه بالوحدة الأولى؛ الفراغ يعطل التنبيه والصفر صالح" },
] as const;
type NumericField = (typeof compactNumericFields)[number]["key"];
export type CompactItemSnapshot = Pick<Item, NumericField | "reviewed">;
export type CompactItemDraft = Record<NumericField,string> & { reviewed:boolean };

export const compactItemDraft = (item:CompactItemSnapshot):CompactItemDraft => ({
  reserveQuantity: item.reserveQuantity,
  purchaseFactor: String(item.purchaseFactor),
  minOrderQuantity: item.minOrderQuantity,
  orderAlertQuantity: item.orderAlertQuantity ?? "",
  reviewed: item.reviewed,
});

export function stepCompactItemValue(key:NumericField, value:string, direction:-1|1): string {
  const field = compactNumericFields.find(x=>x.key===key)!;
  const text = normalizeDigits(value.trim());
  if (text==="" && direction===1) return field.min.toString();
  if (!/^\d{1,22}$/.test(text)) return value;
  const current=BigInt(text), next=current+BigInt(direction);
  return next>=field.min && next<=field.max ? next.toString() : value;
}

export function compactItemFieldPatch(item:CompactItemSnapshot,draft:CompactItemDraft) {
  // Use the same parsers as the full card, including its exact integer and
  // Arabic-digit handling. A blank alert value explicitly means null, not 0.
  const parsers = {
    reserveQuantity: itemWholeQuantitySchema.safeParse(draft.reserveQuantity),
    purchaseFactor: itemFactorSchema.safeParse(draft.purchaseFactor),
    minOrderQuantity: itemMinOrderQuantitySchema.safeParse(draft.minOrderQuantity),
    orderAlertQuantity: itemOrderAlertQuantitySchema.safeParse(draft.orderAlertQuantity.trim()===""?null:draft.orderAlertQuantity),
  };
  const changes:Record<string,unknown> = {}, expected:Record<string,unknown> = {};
  for (const {key,label} of compactNumericFields) {
    const parsed = parsers[key];
    if (!parsed.success)
      return {error:`${label}: ${parsed.error.issues[0]?.message ?? "تحقق من القيمة."}`} as const;
    if (parsed.data !== item[key]) {
      changes[key]=parsed.data;
      expected[key]=item[key];
    }
  }
  if (draft.reviewed!==item.reviewed) {
    changes.reviewed=draft.reviewed;
    expected.reviewed=item.reviewed;
  }
  if (!Object.keys(changes).length) return {payload:null} as const;
  const validated = itemFieldPatchSchema.safeParse({changes,expected});
  return validated.success ? {payload:validated.data} as const :
    {error:validated.error.issues[0]?.message ?? "تحقق من القيم."} as const;
}

export type CompactItemField = keyof CompactItemDraft;
export type CompactItemValue = string | boolean;

export function compactItemSingleFieldPatch(item:CompactItemSnapshot,key:CompactItemField,value:CompactItemValue) {
  return compactItemFieldPatch(item,{...compactItemDraft(item),[key]:value});
}

/** Each field has one request in flight and retains only its latest committed
 * intent. Different fields stay independent under validation/network errors. */
export function createCompactItemAutosave(
  canUse: () => boolean,
  save: (key:CompactItemField,value:CompactItemValue)=>Promise<void>,
  onPending: (key:CompactItemField,pending:boolean)=>void,
) {
  const inFlight=new Set<CompactItemField>();
  const next=new Map<CompactItemField,CompactItemValue>();
  const enqueue=async(key:CompactItemField,value:CompactItemValue)=>{
    if (!canUse()) return;
    next.set(key,value);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    onPending(key,true);
    try {
      while (canUse() && next.has(key)) {
        const current=next.get(key)!;
        next.delete(key);
        await save(key,current);
      }
    } finally {
      inFlight.delete(key);
      next.delete(key);
      if (canUse()) onPending(key,false);
    }
  };
  return {enqueue,isPending:(key:CompactItemField)=>inFlight.has(key)};
}

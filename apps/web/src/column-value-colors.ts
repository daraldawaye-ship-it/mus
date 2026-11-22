import type {TableColumnDefault, TableColumnDefaultId} from "../../../packages/contracts/src/table-column-defaults";

export const columnValueColors = [
  {tone:"green",label:"أخضر",value:"#22a067"},
  {tone:"orange",label:"برتقالي",value:"#e88c22"},
  {tone:"red",label:"أحمر",value:"#dd494d"},
  {tone:"blue",label:"أزرق",value:"#4389e9"},
] as const;
type ValueTone = (typeof columnValueColors)[number]["tone"];

const controls: Record<TableColumnDefaultId, ReadonlySet<string>> = {
  "item-options-list":new Set(["choice","reserve","purchaseFactor","minOrderQuantity","orderAlertQuantity","orderStoppedUntil","reviewed","purchaseNotes"]),
  "journal-lines":new Set(["document"]),
};
export const canColorColumnValue = (table:TableColumnDefaultId, id:string) => !controls[table].has(id);

/** Keep old saved hex colors readable while offering only four named hues. */
export function columnValueTone(color:string|null|undefined):ValueTone|undefined {
  if(!color || !/^#[0-9a-f]{6}$/i.test(color))return;
  const exact=columnValueColors.find(option=>option.value===color.toLowerCase());
  if(exact)return exact.tone;
  const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
  const max=Math.max(r,g,b), min=Math.min(r,g,b), delta=max-min;
  if(delta<18)return;
  const hue=((max===r?(g-b)/delta:max===g?2+(b-r)/delta:4+(r-g)/delta)*60+360)%360;
  return hue<16||hue>=310?"red":hue<74?"orange":hue<165?"green":"blue";
}
export function savedValueColor(table:TableColumnDefaultId,row:TableColumnDefault):string|null {
  if(!canColorColumnValue(table,row.id))return null;
  return columnValueColors.find(option=>option.tone===columnValueTone(row.color))?.value??null;
}

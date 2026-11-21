import type { CompositionClassification } from "../../../packages/contracts/src/items";
export type DraftPrintClassification = CompositionClassification | null;
const suppliesOrder = ["medical_supplies","medical_and_health_supplies","health_supplies"] as const;
type DraftPrintItem = { itemId:number };

export type DraftSectionRow<T> = T & { separatorBefore: boolean };

/** Stable order for every bucket. Null is verified unclassified; missing is not. */
export function orderDraftPrintSections<T extends DraftPrintItem>(
  rows:readonly T[], classifications:ReadonlyMap<number,DraftPrintClassification>,
): DraftSectionRow<T>[][] | null {
  const medicines:DraftSectionRow<T>[]=[];
  const supplies=new Map<DraftPrintClassification,DraftSectionRow<T>[]>(suppliesOrder.map(kind=>[kind,[]]));
  for (const row of rows) {
    const classification=classifications.get(row.itemId);
    if (classification===undefined) return null;
    const group= supplies.get(classification);
    if(group) group.push({...row,separatorBefore:false});
    else if(classification===null||classification==="medicine") medicines.push({...row,separatorBefore:false});
    else return null;
  }
  const suppliesRows:DraftSectionRow<T>[]=[];
  for(const kind of suppliesOrder) {
    const group=supplies.get(kind)!;
    if(!group.length) continue;
    if(suppliesRows.length) group[0]={...group[0],separatorBefore:true};
    suppliesRows.push(...group);
  }
  return [medicines,suppliesRows].filter(section=>section.length>0);
}

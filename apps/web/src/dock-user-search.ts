type UserLookupActor = {owner:boolean};
type UserLookupPage = {key:string; enabled:boolean; actionAccess:{view:boolean}};
type UserLookupRow = {id:number; displayName?:string; name?:string};
export type DockUserChoice = {id:number; name:string};

export const canSearchDockUsers=(actor:UserLookupActor,pages:readonly UserLookupPage[]|undefined)=>
  actor.owner && !!pages?.some(page=>page.key==="public.users" && page.enabled && page.actionAccess.view);

export function dockUserSearchPath(value:string) {
  const q=value.trim().slice(0,100);
  return q ? `/users?${new URLSearchParams({q,page:"1",pageSize:"10",sort:"displayName:asc",archived:"false"})}` : null;
}

/** Project before storing results in the separate query cache. */
export function dockUserSearchNames(rows:readonly UserLookupRow[]) {
  return rows.flatMap(row=>{
    const name=row.displayName?.trim() || row.name?.trim();
    return Number.isSafeInteger(row.id) && row.id>0 && name ? [{id:row.id,name}] : [];
  });
}

/** Qualify only display names that refer to more than one returned account. */
export function dockUserCollisionIds(rows:readonly DockUserChoice[]) {
  const byName = new Map<string,Set<number>>();
  for (const {id,name} of rows) {
    const label = name.normalize("NFC");
    const ids = byName.get(label) ?? new Set<number>();
    ids.add(id);
    byName.set(label,ids);
  }
  const result = new Set<number>();
  for (const ids of byName.values()) if (ids.size>1) for (const id of ids) result.add(id);
  return result;
}

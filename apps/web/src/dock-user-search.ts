type UserLookupActor = {owner:boolean};
type UserLookupPage = {key:string; enabled:boolean; actionAccess:{view:boolean}};
type UserLookupRow = {id:number; displayName?:string; name?:string};

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

export type DockReferenceKind = "item"|"account"|"employee"|"user";
export type DockReference = {kind:DockReferenceKind; id:number; name:string};
export type DockReferenceScope = {
  companyId:number|null; companyRoute:boolean; userRoute:boolean;
  item:boolean; account:boolean; user:boolean;
};
type Row = Record<string,unknown>;
const reference=(kind:DockReferenceKind,id:unknown,name:unknown):DockReference|undefined=>{
  if(typeof id!=="number"||!Number.isSafeInteger(id)||id<=0||typeof name!=="string"||!name.trim())return;
  return {kind,id,name:name.trim()};
};

/** Named ID and matching label must both come from the same row; generic
 * primary IDs are only considered when the table explicitly names its entity. */
export function dockReferences(row:unknown,scope:DockReferenceScope,ownKind?:DockReferenceKind) {
  if(!row||typeof row!=="object")return [];
  const data=row as Row;
  if(!scope.companyRoute||!scope.companyId||("companyId" in data && data.companyId!==scope.companyId)){
    const user=ownKind==="user" && scope.userRoute && scope.user ?
      reference("user",data.id,data.displayName??data.name):undefined;
    return user?[user]:[];
  }
  const known = {
    item:[["itemId","itemName"]],
    account:[["accountId","accountName"],["cashboxAccountId","cashboxAccountName"],["counterpartyAccountId","counterpartyAccountName"],["supplierAccountId","supplierAccountName"]],
    employee:[["employeeId","employeeName"],["doctorEmployeeId","doctorEmployeeName"]],
  } as const;
  const results:DockReference[]=[];
  for(const kind of ["item","account","employee"] as const){
    if(kind==="employee"?!scope.user:!scope[kind])continue;
    const candidates=new Map<number,DockReference>();
    const add=(candidate:DockReference|undefined)=>{if(candidate&&!candidates.has(candidate.id))candidates.set(candidate.id,candidate);};
    if(ownKind===kind)add(reference(kind,data.id,data.name));
    for(const [id,name] of known[kind]){
      if(id==="supplierAccountId" && "supplierInferenceSource" in data && data.supplierInferenceSource!=="invoice")continue;
      add(reference(kind,data[id],data[name]));
    }
    if(candidates.size===1)results.push([...candidates.values()][0]!);
  }
  return results;
}

export const dockInteractiveSelector="button,input,select,textarea,a,label,summary,[contenteditable]:not([contenteditable=false]),[role=button],[role=link],[role=checkbox],[role=switch],[role=combobox],[role=slider],[draggable=true],[data-no-dock-sync]";

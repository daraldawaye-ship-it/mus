export type DockReferenceKind = "item"|"account"|"employee"|"user";
export type DockReferenceSource = DockReferenceKind | "audit-actor";
export type DockReference = {kind:DockReferenceKind; id:number; name:string};
export type DockReferenceScope = {
  companyId:number|null; companyRoute:boolean; userRoute:boolean;
  item:boolean; account:boolean; user:boolean;
  auditRoute?:"company"|"public";
};
type Row = Record<string,unknown>;
const reference=(kind:DockReferenceKind,id:unknown,name:unknown):DockReference|undefined=>{
  if(typeof id!=="number"||!Number.isSafeInteger(id)||id<=0||typeof name!=="string"||!name.trim())return;
  return {kind,id,name:name.trim()};
};

/** Named ID and matching label must both come from the same row; generic
 * primary IDs are only considered when the table explicitly names its entity. */
export function dockReferences(row:unknown,scope:DockReferenceScope,ownKind?:DockReferenceSource) {
  if(!row||typeof row!=="object")return [];
  const data=row as Row;
  if(ownKind==="audit-actor"){
    const matchingAudit = scope.auditRoute==="company"
      ? scope.companyRoute && !!scope.companyId && data.scope==="company" && data.companyId===scope.companyId
      : scope.auditRoute==="public" && !scope.companyRoute && data.scope==="public" && data.companyId===null;
    const actor=scope.user && matchingAudit && typeof data.actorName==="string" && data.actorName.trim()!=="النظام"
      ? reference("user",data.actorId,data.actorName) : undefined;
    return actor?[actor]:[];
  }
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

/** A stopped-purchase alert's canonical in-company link identifies its item.
 * The stored alert supplies only the label; item code or message text is never the ID. */
export function stoppedPurchaseDockSource(
  record: {code:string;companyId:number|null;href?:string|null;message:string},
  companyId?:number,
) {
  if (!companyId || record.companyId !== companyId || record.code !== "PURCHASE_STOPPED_ORDER" || !record.href) return;
  const prefix = `/companies/${companyId}/stopped-order-items?`;
  if (!record.href.startsWith(prefix)) return;
  const params = new URLSearchParams(record.href.slice(prefix.length));
  const ids = params.getAll("itemId");
  const itemId = Number(ids[0]);
  if (ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0]!) || !Number.isSafeInteger(itemId)) return;
  const itemName = /^تم شراء الصنف «([\s\S]+?)»\s*\(الرمز\s*[:：]/u.exec(record.message)?.[1]?.trim();
  if (!itemName) return;
  return {companyId,itemId,itemName};
}

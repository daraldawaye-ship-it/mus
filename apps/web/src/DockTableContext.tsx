import {createContext,useCallback,useContext,useState,type ReactNode} from "react";
import {dockReferences,type DockReference,type DockReferenceKind,type DockReferenceScope} from "./dock-table-references";

type Update=(row:unknown,ownKind?:DockReferenceKind)=>void;
const UpdateContext=createContext<Update|undefined>(undefined);
const SelectionContext=createContext<Partial<Record<"item"|"account"|"user",DockReference>>>({});
export const useDockTableUpdate=()=>useContext(UpdateContext);
export const useDockTableSelection=()=>useContext(SelectionContext);

export function DockTableContext({scope,scopeKey,children}:{scope:DockReferenceScope;scopeKey:string;children:ReactNode}){
  const [selections,setSelections]=useState<{key:string;value:Partial<Record<"item"|"account"|"user",DockReference>>}>({key:scopeKey,value:{}});
  const {companyId,companyRoute,userRoute,item,account,user}=scope;
  const update=useCallback<Update>((row,ownKind)=>{
    const refs=dockReferences(row,{companyId,companyRoute,userRoute,item,account,user},ownKind);
    if(!refs.length)return;
    setSelections(previous=>{
      const next=previous.key===scopeKey?{...previous.value}:{};
      for(const entry of refs)next[entry.kind==="employee"?"user":entry.kind]=entry;
      return {key:scopeKey,value:next};
    });
  },[companyId,companyRoute,userRoute,item,account,user,scopeKey]);
  return <UpdateContext.Provider value={update}><SelectionContext.Provider value={selections.key===scopeKey?selections.value:{}}>
    {children}
  </SelectionContext.Provider></UpdateContext.Provider>;
}

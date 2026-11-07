import {useSyncExternalStore} from "react";
import type {User} from "../../../packages/contracts/src/index.ts";

export interface EmployeePreview {
  companyId:number;
  employeeId:number;
  employeeName:string;
  user:User;
}
let current:EmployeePreview|null=null;
const subscriptions=new Set<()=>void>();
const publish=()=>subscriptions.forEach(listener=>listener());
export const readEmployeePreview=()=>current;
export function startEmployeePreview(target:EmployeePreview){
  if(target.user.owner||!Number.isSafeInteger(target.companyId)||
     !Number.isSafeInteger(target.employeeId)||target.employeeId<1||
     target.companyId<1)throw new Error("موظف المعاينة غير صالح");
  current=target;
  publish();
}
export function stopEmployeePreview(){
  if(!current)return;
  current=null;
  publish();
}
const subscribe=(callback:()=>void)=>{
  subscriptions.add(callback);
  return ()=>{subscriptions.delete(callback);};
};
const serverSnapshot=()=>null;
export function useEmployeePreview(){
  return useSyncExternalStore(subscribe,readEmployeePreview,serverSnapshot);
}
export function isAllowedPreviewRead(path:string,companyId:number){
  const url=new URL(path,"https://alraesy-preview.invalid");
  const companyMatch=/^\/companies\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if(companyMatch && Number(companyMatch[1])===companyId)return true;
  if(/^\/page-catalog(?:\/|$)/.test(url.pathname) &&
     url.searchParams.get("companyId")===String(companyId))return true;
  return false;
}

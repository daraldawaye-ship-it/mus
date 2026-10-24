import type { Database } from "./db.ts";
import type { User } from "../../../packages/contracts/src/index.ts";
import { HttpError } from "./errors.ts";

export type GeneralTableRole = "viewer" | "editor";

export async function generalTableRole(db:Database,user:User,tableName:string):Promise<"owner"|GeneralTableRole|null>{
  if(user.suspended) return null;
  if(user.owner) return "owner";
  const rows=await db.query(
    "SELECT role FROM general_table_grants WHERE user_id=$1 AND table_name=$2",
    [user.id,tableName],
  );
  return (rows.rows[0]?.role as GeneralTableRole|undefined)??null;
}

export async function assertGeneralTableAccess(db:Database,user:User,tableName:string,required:"viewer"|"editor"="viewer"):Promise<void>{
  const role=await generalTableRole(db,user,tableName);
  if(!role || (required==="editor" && role==="viewer"))
    throw new HttpError(403,"general_table_forbidden","هذا الجدول متاح للمالك أو لمن منحه المالك صلاحية محددة");
}

export async function hasGeneralTableAccess(db:Database,user:User):Promise<boolean>{
  if(user.suspended) return false;
  if(user.owner) return true;
  const result=await db.query("SELECT 1 FROM general_table_grants WHERE user_id=$1 LIMIT 1",[user.id]);
  return Boolean(result.rowCount);
}

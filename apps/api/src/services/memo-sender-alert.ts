import type {PoolClient} from "pg";
import {userDTO} from "../repositories/models.ts";
import {directoryEntries} from "./pages.ts";
import {audit} from "./audit.ts";
import {effectiveTemplate,emitNotification} from "./notifications.ts";
export async function notifyDueMemoSender(client:PoolClient,companyId:number,
 memoId:number,title:string,senderUserId:number,assigneeUserId:number,revision:number) {
 if(senderUserId===assigneeUserId)return;
 const setting=(await client.query("SELECT notify_sender FROM memo_reminder_settings WHERE company_id=$1",[companyId])).rows[0];
 if(!setting?.notify_sender)return;
 const template=await effectiveTemplate(client,companyId,"MEMO_DELAYED");
 if(!template?.enabled)return;

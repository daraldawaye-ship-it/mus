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
 const sender=(await client.query(
  "SELECT u.*,e.id AS employee_id FROM users u LEFT JOIN employees e ON e.user_id=u.id AND e.company_id=$1 AND e.active WHERE u.id=$2 AND NOT u.archived AND NOT u.suspended",
  [companyId,senderUserId])).rows[0];
 if(!sender || (!sender.owner && !sender.employee_id))return;
 try{
  const pages=await directoryEntries(client,userDTO(sender),companyId);
  if(!["company.memos","company.memo-detail","company.notifications"]
    .every(key=>pages.find(page=>page.key===key)?.actionAccess.view))return;
 }catch{return;}
 const alert=(await client.query(
  "SELECT id,reminder_count FROM notifications WHERE company_id=$1 AND code='MEMO_DELAYED' AND subject_key=$2 AND recipient_user_id=$3 AND completed_at IS NULL FOR UPDATE",
  [companyId,`memo:${memoId}`,senderUserId])).rows[0];
 if(alert){
  await client.query(
    "UPDATE notifications SET read_at=NULL,reminder_count=reminder_count+1,last_reminded_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",
    [alert.id]);
  await audit(client,null,"notification.remind","notification",alert.id,
    {reminderCount:alert.reminder_count},{reminderCount:alert.reminder_count+1,reason:"memo-sender-due"},companyId);
 }else {

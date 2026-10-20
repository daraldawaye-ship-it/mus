import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

type CashboxAlertKind="pouch"|"electronic"|"close";
interface CashboxAlert {
  companyId:number;
  operationId:number;
  employeeName:string;
  kind:CashboxAlertKind;
  amount:string;
  variance:string|null;
}

/** Only employees whose current company card explicitly includes the cashier
 * position receive these alerts. Saving the operation and all notifications
 * shares one transaction, so no alert is sent for a failed posting or retry. */
export async function notifyCompanyCashiers(
  client:PoolClient, input:CashboxAlert,
):Promise<void>{
  const cashiers=await client.query<{id:number;user_id:number}>(
    "SELECT e.id,e.user_id FROM employees e JOIN users u ON u.id=e.user_id"+
    " WHERE e.company_id=$1 AND e.active AND NOT u.archived AND NOT u.suspended"+
    " AND 'cashier'=ANY(e.position_keys)"+
    " ORDER BY e.id",
    [input.companyId],
  );
  const code=input.kind==="electronic"?"CASHBOX_ELECTRONIC_TRANSFER":
    input.kind==="pouch"?"CASHBOX_POUCH_TRANSFER":"CASHBOX_CLOSED";
  const amount=input.amount+" ر.ي";
  const title=input.kind==="electronic"?"ترحيل إلى المحفظة الإلكترونية":
    input.kind==="pouch"?"ترحيل مبلغ":"إغلاق الصندوق";
  const message=input.kind==="electronic"
    ? input.employeeName+" رحّل "+amount+" إلى المحفظة الإلكترونية."
    : input.kind==="pouch"
      ? input.employeeName+(input.amount.startsWith("-")
          ?" استلم "+input.amount.slice(1)+" ر.ي من الحافظة."
          :" رحّل "+amount+" إلى الحافظة.")
      : input.employeeName+" أغلق الصندوق، النقد الفعلي "+amount+
          (input.variance!==null && input.variance!=="0"
            ? "، الفرق المسجل "+input.variance+" ر.ي." : "، دون فرق.");
  for(const cashier of cashiers.rows){
    await emitNotification(client,{
      code,companyId:input.companyId,
      subjectEmployeeId:cashier.id,
      recipientUserId:cashier.user_id,
      subjectKey:"cashbox-operation:"+input.operationId,
      eventKey:code+":"+input.operationId,
      title,message,
      href:"/companies/"+input.companyId+"/notifications",
      // No company manager, unrelated employee, or configured follower may
      // receive an event intended for the explicitly designated cashier.
      explicitSubjectOnly:true,
    });
  }
}

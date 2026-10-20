/** Privacy-preserving Web Push permission reminders; native denied grants
 * cannot be requested again until the user changes browser/OS settings. */
export const PUSH_REMINDER_INTERVAL_MS=3*24*60*60*1000;
export function denialReminderDue(lastDenied:number|null,now:number):boolean{
  return lastDenied!==null && Number.isFinite(lastDenied) &&
    lastDenied>0 && now-lastDenied>=PUSH_REMINDER_INTERVAL_MS;
}

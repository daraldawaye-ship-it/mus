import { useState, useSyncExternalStore } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { Button } from "./ui";
import {
  connectionSnapshot, returnToOnline, setManualOffline, subscribeConnection,
} from "./connection-mode";

/** Never remount the active invoice when switching the transport mode. */
export function ConnectionModeControl() {
  const state = useSyncExternalStore(subscribeConnection, connectionSnapshot, () => "online");
  const [busy,setBusy] = useState(false);
  const [warning,setWarning] = useState("");
  const offline = state !== "online";
  async function toggle() {
    setWarning("");
    if (!offline) {
      setManualOffline();
      return;
    }
    setBusy(true);
    try {
      if (!(await returnToOnline())) setWarning("لم يعد اتصال الخادم متاحًا بعد. يمكنك متابعة العمل محليًا.");
    } finally { setBusy(false); }
  }
  return <div className="connection-mode-control">
    <Button size="compact" variant="ghost" disabled={busy}
      className="connection-mode-button"
      onClick={() => void toggle()}
      title={offline ? "التحقق من الاتصال والعودة إلى العمل المباشر" : "استخدام النسخ المحلية وحفظ العمليات للمزامنة"}>
      {offline ? <WifiOff size={15} aria-hidden="true"/> : <Wifi size={15} aria-hidden="true"/>}
      <span>{offline ? "العودة إلى وضع الاتصال" : "وضع عدم الاتصال"}</span>
    </Button>
    {offline && <span className="connection-mode-indicator" role="status">دون إنترنت</span>}
    {warning && <span className="connection-mode-warning" role="status">{warning}</span>}
  </div>;
}

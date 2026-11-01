import { useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import { Button } from "./ui";
import {
  connectionSnapshot, returnToOnline, subscribeConnection,
} from "./connection-mode";

/** Never remount the active invoice when switching the transport mode. */
export function ConnectionModeControl() {
  const state = useSyncExternalStore(subscribeConnection, connectionSnapshot, () => "online");
  const [busy,setBusy] = useState(false);
  const [warning,setWarning] = useState("");
  const offline = state !== "online";
  async function reconnect() {
    setWarning("");
    setBusy(true);
    try {
      if (!(await returnToOnline())) setWarning("لم يعد اتصال الخادم متاحًا بعد. يمكنك متابعة العمل محليًا.");
    } finally { setBusy(false); }
  }
  // Keep the header uncluttered when the server is reachable.
  // This is only a recovery control, never a manual disconnect action.
  if (!offline) return null;
  return <div className="connection-mode-control">
    <Button size="compact" variant="ghost" disabled={busy}
      className="connection-mode-button"
      onClick={() => void reconnect()}
      title="التحقق من الاتصال والعودة إلى العمل المباشر"
      aria-label="العودة إلى وضع الاتصال">
      <WifiOff size={15} aria-hidden="true"/>
      <span className="connection-mode-label">العودة إلى وضع الاتصال</span>
    </Button>
    <span className="connection-mode-indicator" role="status">دون إنترنت</span>
    {warning && <span className="connection-mode-warning" role="status">{warning}</span>}
  </div>;
}

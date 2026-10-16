import { useEffect } from "react";
import { useControls } from "./control";
import { useSession } from "./api";

/** A client-side idle session close for the active company's employee. */
export function useCompanyIdleLogout(
  companyId: number,
  employeeId: number | null,
  active: boolean,
) {
  const { user, logout } = useSession();
  const controls = useControls(companyId, employeeId);
  const hours = controls.value("idle_logout_hours");
  useEffect(() => {
    if (!user || !active || !employeeId || typeof hours !== "number" || hours <= 0) return;
    let lastActivity = Date.now();
    let pending = false;
    const mark = () => { lastActivity = Date.now(); };
    const check = () => {
      if (pending || Date.now() - lastActivity < hours * 3_600_000) return;
      pending = true;
      void logout().catch(() => { pending = false; lastActivity = Date.now(); });
    };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach(event => window.addEventListener(event, mark, { passive: true }));
    const interval = window.setInterval(check, 30_000);
    const visible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      events.forEach(event => window.removeEventListener(event, mark));
    };
  }, [user?.id, active, companyId, employeeId, hours]);
}

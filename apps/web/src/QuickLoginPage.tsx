import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SessionResponse } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { Card, Notice, PageHeader } from "./ui";

/** The bearer token lives only in the URL fragment, which is never sent in
 * an HTTP path/query or Referrer. Remove it before making the POST request. */
export function QuickLoginPage() {
  const { acceptRegistration } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, "", "/quick-login");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("رابط الدخول غير صالح. اطلب رابطًا جديدًا من إدارة الموقع.");
      setBusy(false);
      return;
    }
    void (async () => {
      try {
        const session = await api<SessionResponse>("/auth/login-link/redeem", {
          method: "POST", body: { token },
        });
        await acceptRegistration(session);
        navigate("/", { replace: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "تعذر الدخول بالرابط.");
        setBusy(false);
      }
    })();
  }, [acceptRegistration, navigate]);
  return <>
    <PageHeader title="دخول مباشر إلى الحساب"
      description="يعمل الرابط مرة واحدة، وتنتهي صلاحيته بعد ساعة من إنشائه." />
    <Card>
      {busy ? <p>جارٍ الدخول إلى الحساب باستخدام الرابط الشخصي…</p> :
        <Notice tone="error">{error}</Notice>}
      {!busy && <Link className="button button-secondary" to="/login">
        تسجيل الدخول بكلمة المرور
      </Link>}
    </Card>
  </>;
}

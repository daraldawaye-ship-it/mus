import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SessionResponse } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { Button, Card, Notice, PageHeader } from "./ui";

/** A link preview, browser prefetch, or opening the page must never use the
 * single-use credential. Keep it only in memory and remove the URL fragment
 * immediately so it never reaches server paths, logs or referrers. */
export function QuickLoginPage() {
  const { acceptRegistration } = useSession();
  const navigate = useNavigate();
  const tokenRef = useRef<string | null>(null);
  const initialized = useRef(false);
  const [validToken, setValidToken] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, "", "/quick-login");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("رابط الدخول غير مكتمل أو غير صالح. افتح الرابط الأصلي كاملاً أو اطلب رابطًا جديدًا من الإدارة.");
      return;
    }
    tokenRef.current = token;
    setValidToken(true);
  }, []);

  async function redeemLink() {
    const token = tokenRef.current;
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      // Claim the link only when the intended user explicitly presses Login.
      const session = await api<SessionResponse>("/auth/login-link/redeem", {
        method: "POST", body: { token },
      });
      tokenRef.current = null;
      await acceptRegistration(session);
      navigate("/", { replace: true });
    } catch (cause) {
      // Keep the in-memory token on transient failures for an intentional retry.
      // The server may have consumed it if a response was lost; a fresh link
      // can still be issued by the owner without exposing bearer credentials.
      setError(cause instanceof Error ? cause.message : "تعذر تسجيل الدخول بالرابط.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeader title="دخول مباشر إلى الحساب"
      description="الرابط صالح لساعة من إنشائه ولمرة واحدة. فتحه وحده لا يستهلكه؛ اضغط الزر أدناه للدخول." />
    <Card>
      {validToken && <Button onClick={() => void redeemLink()} disabled={busy || !tokenRef.current}>
        {busy ? "جارٍ تسجيل الدخول…" : "دخول إلى الحساب"}
      </Button>}
      {error && <Notice tone="error">{error}</Notice>}
      {error && <p className="muted">إذا أُنشئ رابط آخر لنفس الحساب، يتوقف الرابط السابق. ويمكنك تسجيل الدخول برقم الهاتف وكلمة المرور بدل الرابط.</p>}
      <Link className="button button-secondary" to="/login">
        تسجيل الدخول بكلمة المرور
      </Link>
    </Card>
  </>;
}

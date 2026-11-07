import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { SessionResponse } from "../../../packages/contracts/src/index";
import { ApiFailure, api, useSession } from "./api";
import { Button, Card, Field, Notice, PageHeader } from "./ui";

/** A link preview, browser prefetch, or opening the page must never use the
 * single-use credential. Keep it only in memory and remove the URL fragment
 * immediately so it never reaches server paths, logs or referrers. */
export function QuickLoginPage() {
  const { acceptRegistration } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const tokenRef = useRef<string | null>(null);
  const initialized = useRef(false);
  const [validToken, setValidToken] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pastedLink, setPastedLink] = useState("");

  useEffect(() => {
    // A new link can open on the same React Router route without remounting.
    const token = window.location.hash.slice(1);
    if (!token) {
      if (!initialized.current)
        setError("لم يصل رمز الدخول مع الرابط. الصق الرابط الكامل أدناه أو اطلب رابطًا جديدًا.");
      initialized.current = true;
      return;
    }
    initialized.current = true;
    window.history.replaceState(window.history.state, "", "/quick-login");
    tokenRef.current = null;
    setValidToken(false);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("رابط الدخول غير مكتمل أو غير صالح. الصق الرابط الأصلي كاملًا أو اطلب رابطًا جديدًا من الإدارة.");
      return;
    }
    tokenRef.current = token;
    setError("");
    setValidToken(true);
  }, [location.hash]);

  function importPastedLink() {
    // Import a copied URL locally when a messenger dropped its fragment.
    let token = "";
    try {
      const parsed = new URL(pastedLink.trim());
      if (parsed.origin !== window.location.origin || parsed.pathname !== "/quick-login")
        throw new Error("الرابط ليس من موقع الرئيسي.");
      token = parsed.hash.slice(1);
    } catch {
      setError("الصق رابط الدخول الكامل من موقع الرئيسي، شاملاً الجزء الذي يبدأ بعلامة #.");
      return;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("الرابط المنسوخ لا يحتوي على رمز دخول كامل. انسخه مجددًا من الإدارة.");
      return;
    }
    tokenRef.current = token;
    setPastedLink("");
    setValidToken(true);
    setError("");
  }

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
      if (cause instanceof ApiFailure && cause.code === "invalid_link") {
        tokenRef.current = null;
        setValidToken(false);
      }
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
      <div className="form-grid">
        <Field className="form-full" label="لصق رابط الدخول الكامل (عند عدم عمل فتح الرابط)"
          type="text" dir="ltr" autoComplete="off" spellCheck={false}
          value={pastedLink} onChange={event => setPastedLink(event.target.value)}
          placeholder="https://.../quick-login#..." />
        <Button variant="secondary" onClick={importPastedLink} disabled={!pastedLink.trim() || busy}>
          استخدام الرابط الملصق
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {error && <p className="muted">إذا أُنشئ رابط آخر لنفس الحساب، يتوقف الرابط السابق. ويمكنك تسجيل الدخول برقم الهاتف وكلمة المرور بدل الرابط.</p>}
      <Link className="button button-secondary" to="/login">
        تسجيل الدخول بكلمة المرور
      </Link>
    </Card>
  </>;
}

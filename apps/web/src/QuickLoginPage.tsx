import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { SessionResponse } from "../../../packages/contracts/src/index";
import { ApiFailure, api, useSession } from "./api";
import { Button, Card, Field, Notice, PageHeader } from "./ui";

/** A link preview, browser prefetch, or opening the page must never use the
 * single-use credential until a real browser shows the page. Keep the token
 * only in memory; remove the fragment before requesting the server. */
export function QuickLoginPage() {
  const { acceptRegistration } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const tokenRef = useRef<string | null>(null);
  const initialized = useRef(false);
  const automaticAttemptsRef = useRef(new Set<string>());
  const redeemingRef = useRef(false);
  const [validToken, setValidToken] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pastedLink, setPastedLink] = useState("");

  useEffect(() => {
    // Read the credential once from the hash, before removing it from the URL.
    // A StrictMode effect replay can recover it from the in-memory ref.
    const fragment = window.location.hash.slice(1);
    const token = fragment || tokenRef.current;
    if (!token) {
      if (!initialized.current)
        setError("لم يصل رمز الدخول مع الرابط. الصق الرابط الكامل أدناه أو اطلب رابطًا جديدًا.");
      initialized.current = true;
      return;
    }
    initialized.current = true;
    if (fragment) window.history.replaceState(window.history.state, "", "/quick-login");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      tokenRef.current = null;
      setValidToken(false);
      setError("رابط الدخول غير مكتمل أو غير صالح. الصق الرابط الأصلي كاملًا أو اطلب رابطًا جديدًا من الإدارة.");
      return;
    }
    if (fragment) {
      tokenRef.current = token;
      setError("");
      setValidToken(true);
    }

    // Owner-requested auto login: no confirmation button on a visible page.
    // Do not claim the single-use credential while a page is hidden/prerendered.
    const enterAutomatically = () => {
      if (document.visibilityState !== "visible" || automaticAttemptsRef.current.has(token)) return;
      automaticAttemptsRef.current.add(token);
      void redeemLink(token);
    };
    enterAutomatically();
    document.addEventListener("visibilitychange", enterAutomatically);
    return () => document.removeEventListener("visibilitychange", enterAutomatically);
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
    void redeemLink(token);
  }

  async function redeemLink(token: string | null = tokenRef.current) {
    if (!token || redeemingRef.current) return;
    redeemingRef.current = true;
    setBusy(true);
    setError("");
    try {
      // The visible, owner-issued login page claims the one-use token automatically.
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
      if (cause instanceof ApiFailure && cause.code === "invalid_link" && tokenRef.current === token) {
        tokenRef.current = null;
        setValidToken(false);
      }
      setError(cause instanceof Error ? cause.message : "تعذر تسجيل الدخول بالرابط.");
    } finally {
      redeemingRef.current = false;
      setBusy(false);
    }
  }

  return <>
    <PageHeader title="دخول مباشر إلى الحساب"
      description="الرابط صالح لساعة من إنشائه ولمرة واحدة. يبدأ تسجيل الدخول تلقائيًا عند فتح الرابط الكامل." />
    <Card>
      {validToken && (busy || !error
        ? <Notice>جارٍ تسجيل الدخول تلقائيًا…</Notice>
        : <Button onClick={() => void redeemLink()} disabled={!tokenRef.current}>
            إعادة محاولة الدخول
          </Button>)}
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

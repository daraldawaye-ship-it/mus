import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  CircleUserRound,
  FileClock,
  LogIn,
  Save,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useQueryClient } from "@tanstack/react-query";
import {
  userKindLabels,
  auditActionLabels,
  publicAuditActions,
  auditTargetLabels,
  userKinds,
  type AuditEvent,
  type ProfileInput,
  type SessionResponse,
  type User,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { DeviceNotificationSettings } from "../DeviceNotificationSettings";
import {
  allowPasswordAutofillOnDevice,
  compactDesktopTextSecret,
  rememberLoginIdentifier,
  savedLoginIdentifier,
} from "../device-login-policy";
import { ImageUpload, thumbnailUrl } from "../ImageUpload";
import { ProfileImageUrlField } from "../ProfileImageUrlField";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Select,
} from "../ui";

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "تعذر إتمام الطلب. يرجى المحاولة مرة أخرى.";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ar", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function canManagePublic(user: User | null): boolean {
  return Boolean(user && (user.owner || user.kind === "admin"));
}

function canReadPublicAudit(user: User | null): boolean {
  return canManagePublic(user) || Boolean(user?.monitor);
}

export function HomePage() {
  const { user } = useSession();
  return (
    <>
      <PageHeader
        title={user ? `مرحبًا، ${user.displayName}` : "الرئيسي"}
        description="حسابك العام، وشركاتك، وفريق عملك في مكان واحد."
      />
      <Card
        title="بداية واضحة لكل حساب"
        description="الهوية العامة مستقلة عن العمل داخل الشركات."
      >
        <p>
          يمكنك استخدام حسابك العام وتحديث بياناتك. يظهر الوصول إلى الشركة عندما
          يرتبط حسابك بموظف فعال فيها؛ لا يمنح نوع الحساب العام عضوية في شركة.
        </p>
        <div className="actions">
          {user ? (
            <>
              <Link className="button button-primary" to="/companies">
                <Building2 size={16} aria-hidden="true" /> الشركات المتاحة
              </Link>
              <Link className="button button-secondary" to="/profile">
                <CircleUserRound size={16} aria-hidden="true" /> حسابي
              </Link>
            </>
          ) : (
            <>
              <Link className="button button-primary" to="/register">
                <UserPlus size={16} aria-hidden="true" /> إنشاء حساب
              </Link>
              <Link className="button button-secondary" to="/login">
                <LogIn size={16} aria-hidden="true" /> تسجيل الدخول
              </Link>
            </>
          )}
        </div>
      </Card>
      {canReadPublicAudit(user) && (
        <div className="card-grid">
          {canManagePublic(user) && (
            <Card
              title="إدارة المستخدمين"
              description="أنواع الحسابات وحالاتها وصلاحياتها العامة."
            >
              <Link className="button button-secondary" to="/users">
                <Users size={16} aria-hidden="true" /> عرض المستخدمين{" "}
                <ArrowLeft size={14} aria-hidden="true" />
              </Link>
            </Card>
          )}
          <Card
            title="السجل العام"
            description="الأحداث المسجلة والقيم الفعلية قبل التغيير وبعده."
          >
            <Link className="button button-secondary" to="/audit">
              <FileClock size={16} aria-hidden="true" /> عرض السجل{" "}
              <ArrowLeft size={14} aria-hidden="true" />
            </Link>
          </Card>
        </div>
      )}
      <Notice>
        الدليل العام والمحتوى والمحاسبة والمخزون مراحل لاحقة. المتاح الآن هو
        أساس الحسابات والشركات والموظفين.
      </Notice>
    </>
  );
}

export function AuthPage({ mode = "login" }: { mode?: "login" | "register" }) {
  const { user, loginWithPassword, acceptRegistration, requiresOnlineLogin } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const oauthReturn = searchParams.get("returnTo");
  const safeReturn = oauthReturn?.startsWith("/oauth/authorize?") &&
    !oauthReturn.includes("\\") && !oauthReturn.includes("//") ? oauthReturn : null;
  const guard = useScopeGuard(`public:auth:${mode}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    displayName: "",
    email: "",
    phone: "",
    password: "",
  });
  const registering = mode === "register";
  const [loginId, setLoginId] = useState(savedLoginIdentifier);
  const [passwordReady, setPasswordReady] = useState(false);
  const allowPasswordAutofill = allowPasswordAutofillOnDevice();
  const desktopTextSecret = compactDesktopTextSecret(allowPasswordAutofill, registering);

  useEffect(() => {
    setBusy(false);
    setError("");
    setDraft({ name: "", displayName: "", email: "", phone: "", password: "" });
    setLoginId(savedLoginIdentifier());
    setPasswordReady(false);
  }, [mode]);
  useEffect(() => {
    // A restored back/forward-cache login form must not expose previously
    // typed credentials to the next employee at a shared computer.
    const resetRestoredPassword = (event: PageTransitionEvent) => {
      if (!event.persisted || allowPasswordAutofill) return;
      setDraft(current => ({...current,password:""}));
      setPasswordReady(false);
    };
    window.addEventListener("pageshow",resetRestoredPassword);
    return () => window.removeEventListener("pageshow",resetRestoredPassword);
  }, [allowPasswordAutofill]);

  if (user && !requiresOnlineLogin) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (registering) {
        const result=await api<SessionResponse>("/auth/register",{
          method:"POST",body:{...draft,image:""},signal:guard.signal,
        });
        if (!guard.isCurrent()) return;
        await acceptRegistration(result);
      } else {
        await loginWithPassword(loginId,draft.password);
        rememberLoginIdentifier(loginId);
      }
      // A successful sign-in changes the user-scoped guard identity.
      // The auth page must still navigate to the selected employee workspace.
      if (safeReturn) {
        // The OAuth approval page is a server route, not a React Router page.
        window.location.assign(safeReturn);
        return;
      }
      navigate("/", { replace: true });
    } catch (cause) {
      if (guard.isCurrent()) setError(messageOf(cause));
    } finally {
      if (guard.isCurrent()) {
        setDraft(current => ({...current,password:""}));
        setPasswordReady(false);
        setBusy(false);
      }
    }
  }

  function update(key: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  }

  return (
    <div className="auth-page">
      <PageHeader
        title={registering ? "إنشاء حساب عام" : "تسجيل الدخول"}
        description={
          registering
            ? "ابدأ بحساب مستقل؛ الانضمام إلى شركة يتم من خلال موظف مرتبط بحسابك."
            : "يمكن لأي موظف سبق دخوله على هذا الجهاز الدخول بكلمة مروره دون إنترنت. تُرسل العمليات بعد تسجيل دخوله عبر الإنترنت مجددًا."
        }
      />
      <Card>
        <form onSubmit={submit} className="form-grid" aria-busy={busy}
          autoComplete={allowPasswordAutofill ? undefined : "off"}>
          {registering && (
            <>
              <Field
                label="الاسم"
                name="name"
                autoComplete="name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                required
                maxLength={120}
                disabled={busy}
              />
              <Field
                label="اسم الظهور"
                name="displayName"
                autoComplete="nickname"
                value={draft.displayName}
                onChange={(event) => update("displayName", event.target.value)}
                maxLength={120}
                disabled={busy}
                hint="اتركه فارغًا لاستخدام الاسم."
              />
            </>
          )}
          {registering ? (
            <>
              <Field
                label="رقم الهاتف الأساسي"
                name="phone"
                type="tel"
                dir="ltr"
                autoComplete="tel"
                value={draft.phone}
                onChange={(event) => update("phone", event.target.value)}
                required
                maxLength={40}
                disabled={busy}
                hint="الرقم مطلوب للدخول، وسيُضاف التحقق برسالة SMS لاحقًا."
              />
              <Field
                label="البريد الإلكتروني (اختياري)"
                name="email"
                type="email"
                dir="ltr"
                autoComplete="email"
                value={draft.email}
                onChange={(event) => update("email", event.target.value)}
                maxLength={254}
                disabled={busy}
              />
            </>
          ) : (
            <Field
              label="رقم الهاتف أو البريد الإلكتروني"
              name={allowPasswordAutofill ? "login" : "employee-identifier"}
              type="text"
              dir="ltr"
              autoComplete={allowPasswordAutofill ? "username" : "off"}
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              required
              maxLength={254}
              disabled={busy}
            />
          )}
          <Field
            label="كلمة المرور"
            name={desktopTextSecret ? "employee-secret-entry" : "password"}
            type={desktopTextSecret ? "text" : "password"}
            className={desktopTextSecret ? "auth-desktop-short-secret" : ""}
            dir={desktopTextSecret ? "ltr" : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete={allowPasswordAutofill
              ? (registering ? "new-password" : "current-password")
              : "off"}
            readOnly={!allowPasswordAutofill && !passwordReady}
            onFocus={() => setPasswordReady(true)}
            value={draft.password}
            onChange={(event) => update("password", event.target.value)}
            required
            minLength={registering ? 12 : undefined}
            maxLength={128}
            hint={registering ? "استخدم 12 حرفًا على الأقل." : undefined}
            disabled={busy}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="actions form-full">
            <Button type="submit" disabled={busy}>
              {registering ? (
                <UserPlus size={16} aria-hidden="true" />
              ) : (
                <LogIn size={16} aria-hidden="true" />
              )}
              {busy
                ? "جارٍ المتابعة…"
                : registering
                  ? "إنشاء الحساب"
                  : "تسجيل الدخول"}
            </Button>
            <Link to={registering ? "/login" : "/register"}>
              {registering ? "لديّ حساب بالفعل" : "إنشاء حساب جديد"}
            </Link>
          </div>
        </form>
      </Card>
      <SocialProviderOptions intent="login" returnTo={safeReturn}/>
    </div>
  );
}

type SocialProviderStatus = {google:boolean;apple:boolean};
const socialErrors:Record<string,string> = {
  social_existing_email:"يوجد حساب مرتبط بهذا البريد. ادخل إلى حسابك باستخدام الهاتف أو البريد وكلمة المرور، ثم اربط Google أو Apple من ملفك الشخصي.",
  social_email_required:"لم يقدم المزود بريدًا إلكترونيًا موثقًا. ادخل إلى حسابك الحالي ثم اربط المزود من ملفك الشخصي.",
  invalid_state:"تعذر التحقق من أمان جلسة الربط. ابدأ العملية من جديد.",
  expired_state:"انتهت صلاحية طلب الربط. حاول مرة أخرى.",
  cancelled:"تم إلغاء التسجيل لدى مزود الدخول.",
  social_taken:"هذا الحساب لدى Google أو Apple مرتبط بمستخدم آخر.",
  social_conflict:"تعذر ربط الحساب؛ تحقق من عدم وجود ارتباط آخر.",
  oidc_token:"تعذر التحقق من هوية الحساب.",
  oidc_exchange:"تعذر إتمام الاتصال بمزود الدخول.",
  social_unavailable:"تعذر إكمال تسجيل الدخول الخارجي.",
};
function SocialProviderOptions({ intent, returnTo }: {
  intent: "login"|"link";returnTo?:string|null;
}) {
  const [available,setAvailable]=useState<SocialProviderStatus|null>(null);
  const [params]=useSearchParams();
  useEffect(()=>{
    let active=true;
    void api<SocialProviderStatus>("/auth/social/providers")
      .then(result=>{if(active)setAvailable(result);})
      .catch(()=>{if(active)setAvailable({google:false,apple:false});});
    return ()=>{active=false;};
  },[]);
  function proceed(provider:"google"|"apple") {
    const query = new URLSearchParams();
    if (intent==="link") query.set("intent","link");
    if (returnTo) query.set("returnTo",returnTo);
    window.location.assign(`/api/auth/social/${provider}/start?${query.toString()}`);
  }
  const error=params.get("socialError");
  const connected=params.get("socialConnected");
  return (
    <Card title={intent==="link"?"ربط حسابات الدخول":"الدخول أو التسجيل بواسطة"}
      description={intent==="link"
        ?"اربط حسابك الحالي بهوية Google أو Apple. لن تُربط الحسابات اعتمادًا على تشابه البريد الإلكتروني وحده."
        :"يمكنك إنشاء حساب جديد أو الدخول بحساب مرتبط باستخدام Google أو Apple."}>
      {error && <Notice tone="error">{socialErrors[error]??"تعذر إتمام تسجيل الدخول الخارجي."}</Notice>}
      {connected && <Notice tone="success">تم ربط حساب {connected==="google"?"Google":"Apple"} بنجاح.</Notice>}
      <div className="actions">
        <Button type="button" variant="secondary" disabled={!available?.google}
          onClick={()=>proceed("google")}>{intent==="link"?"ربط Google":"المتابعة باستخدام Google"}</Button>
        <Button type="button" variant="secondary" disabled={!available?.apple}
          onClick={()=>proceed("apple")}>{intent==="link"?"ربط Apple":"المتابعة باستخدام Apple"}</Button>
      </div>
      {available && !available.google && !available.apple && (
        <p className="muted">خيارا Google وApple جاهزان للربط، لكن يلزم إدخال بيانات OAuth من حسابات المطور قبل تفعيلهـما.</p>
      )}
    </Card>
  );
}

export function ProfilePage() {
  const { user } = useSession();
  if (!user) return <Navigate to="/login" replace />;
  return <ProfileForms key={user.id} user={user} />;
}

function profileOf(user: User): ProfileInput {
  return {
    name: user.name,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    image: user.image,
  };
}

function ProfileForms({ user }: { user: User }) {
  const { reloadSession } = useSession();
  const guard = useScopeGuard("public");
  const [draft, setDraft] = useState<ProfileInput>(() => profileOf(user));
  const [saving, setSaving] = useState(false);
  const [profileNotice, setProfileNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const revision = useRef(0);
  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
    confirmation: "",
  });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const passwordRevision = useRef(0);

  function updateProfile(key: keyof ProfileInput, value: string) {
    revision.current += 1;
    setDraft((current) => ({ ...current, [key]: value }));
    setProfileNotice(null);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const sentRevision = revision.current;
    const sent = { ...draft };
    setSaving(true);
    setProfileNotice(null);
    try {
      const response = await api<{ user: User }>("/profile", {
        method: "PATCH",
        body: sent,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      if (revision.current === sentRevision) {
        setDraft(profileOf(response.user));
        setProfileNotice({ tone: "success", text: "حُفظت بيانات الحساب." });
      }
      await reloadSession();
    } catch (cause) {
      if (guard.isCurrent() && revision.current === sentRevision)
        setProfileNotice({ tone: "error", text: messageOf(cause) });
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }

  function updatePassword(key: keyof typeof passwords, value: string) {
    passwordRevision.current += 1;
    setPasswords((current) => ({ ...current, [key]: value }));
    setPasswordNotice(null);
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordSaving) return;
    if (passwords.newPassword !== passwords.confirmation) {
      setPasswordNotice({
        tone: "error",
        text: "تأكيد كلمة المرور لا يطابق الكلمة الجديدة.",
      });
      return;
    }
    const sentRevision = passwordRevision.current;
    setPasswordSaving(true);
    setPasswordNotice(null);
    try {
      await api("/auth/password", {
        method: "POST",
        body: {
          currentPassword: passwords.currentPassword,
          newPassword: passwords.newPassword,
        },
        signal: guard.signal,
      });
      if (guard.isCurrent() && passwordRevision.current === sentRevision) {
        setPasswords({
          currentPassword: "",
          newPassword: "",
          confirmation: "",
        });
        setPasswordNotice({ tone: "success", text: "تغيّرت كلمة المرور." });
      }
    } catch (cause) {
      if (guard.isCurrent() && passwordRevision.current === sentRevision)
        setPasswordNotice({ tone: "error", text: messageOf(cause) });
    } finally {
      if (guard.isCurrent()) setPasswordSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="حسابي العام"
        description="بيانات هويتك العامة مستقلة عن بياناتك كموظف في أي شركة."
      />
      <Card
        title="بيانات الحساب"
        description={`${userKindLabels[user.kind]}${user.owner ? " · مالك المنصة" : ""}`}
      >
        <form onSubmit={saveProfile} className="form-grid" aria-busy={saving}>
          <Field
            label="الاسم"
            name="name"
            autoComplete="name"
            value={draft.name}
            onChange={(event) => updateProfile("name", event.target.value)}
            required
            maxLength={120}
          />
          <Field
            label="اسم الظهور"
            name="displayName"
            autoComplete="nickname"
            value={draft.displayName}
            onChange={(event) =>
              updateProfile("displayName", event.target.value)
            }
            maxLength={120}
            hint="اتركه فارغًا لاستخدام الاسم."
          />
          <Field
            label="البريد الإلكتروني"
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            value={draft.email}
            onChange={(event) => updateProfile("email", event.target.value)}
            maxLength={254}
          />
          <Field
            label="رقم الهاتف الأساسي"
            name="phone"
            type="tel"
            dir="ltr"
            autoComplete="tel"
            value={draft.phone}
            onChange={(event) => updateProfile("phone", event.target.value)}
            maxLength={40}
          />
          <ImageUpload purpose="avatar" preview={draft.image ? thumbnailUrl(draft.image) : null}
            disabled={saving} onUploaded={({fullUrl})=>updateProfile("image",fullUrl)}
            onClear={()=>updateProfile("image","")} />
          <ProfileImageUrlField
            value={draft.image}
            disabled={saving}
            onChange={(value) => updateProfile("image", value)}
          />
          {profileNotice && (
            <Notice tone={profileNotice.tone}>{profileNotice.text}</Notice>
          )}
          <div className="actions form-full">
            <Button type="submit" disabled={saving}>
              <Save size={16} aria-hidden="true" />
              {saving ? "جارٍ حفظ البيانات…" : "حفظ البيانات"}
            </Button>
          </div>
        </form>
      </Card>
      <DeviceNotificationSettings />
      <SocialProviderOptions intent="link"/>
      <Card
        title="تغيير كلمة المرور"
        description="تحتاج إلى كلمة المرور الحالية لتأكيد التغيير."
      >
        <form
          onSubmit={savePassword}
          className="form-grid"
          aria-busy={passwordSaving}
        >
          <Field
            label="كلمة المرور الحالية"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={passwords.currentPassword}
            onChange={(event) =>
              updatePassword("currentPassword", event.target.value)
            }
            required
            maxLength={128}
          />
          <Field
            label="كلمة المرور الجديدة"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={passwords.newPassword}
            onChange={(event) =>
              updatePassword("newPassword", event.target.value)
            }
            required
            minLength={12}
            maxLength={128}
            hint="12 حرفًا على الأقل."
          />
          <Field
            label="تأكيد كلمة المرور الجديدة"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            value={passwords.confirmation}
            onChange={(event) =>
              updatePassword("confirmation", event.target.value)
            }
            required
            minLength={12}
            maxLength={128}
          />
          {passwordNotice && (
            <Notice tone={passwordNotice.tone}>{passwordNotice.text}</Notice>
          )}
          <div className="actions form-full">
            <Button type="submit" disabled={passwordSaving}>
              <ShieldCheck size={16} aria-hidden="true" />
              {passwordSaving ? "جارٍ تغيير كلمة المرور…" : "تغيير كلمة المرور"}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

type PublicFlag = "archived" | "suspended" | "editor" | "monitor";
const flagLabels: Record<PublicFlag, string> = {
  archived: "مؤرشف",
  suspended: "موقوف عن المشاركة",
  editor: "محرر",
  monitor: "مراقب",
};

export function UsersPage() {
  const { user } = useSession();
  if (!user) return <Navigate to="/login" replace />;
  if (!canManagePublic(user))
    return (
      <Notice tone="error">
        عرض المستخدمين وإدارتهم متاحان لإدارة الموقع العام ومالك المنصة.
      </Notice>
    );
  return <UserList key={user.id} />;
}

function UserList() {
  const { user, reloadSession } = useSession();
  const guard = useScopeGuard("public");
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const kindFilter = params.get("kind") ?? "";
  const archiveFilter = params.get("archived") ?? "";
  const filters = new URLSearchParams();
  if (kindFilter) filters.set("kind", kindFilter);
  if (archiveFilter) filters.set("archived", archiveFilter);
  const list = usePagedQuery<User>(
    `/users${filters.size ? `?${filters}` : ""}`,
    "public",
  );
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [fullValue, setFullValue] = useState<{
    title: string;
    value: string;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<User | null>(null);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [editDraft, setEditDraft] = useState<{name:string;displayName:string;email:string;phone:string;kind: User["kind"];editor:boolean;monitor:boolean;suspended:boolean;archived:boolean}|null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  // Public identities are independent of employees. Only the platform owner
  // may reset another user's sign-in password.
  const [passwordTarget, setPasswordTarget] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  function closePasswordDialog() {
    if (passwordBusy) return;
    setPasswordTarget(null);
    setNewPassword("");
    setPasswordConfirmation("");
    setPasswordError("");
  }

  function openPasswordDialog(target: User) {
    if (!user?.owner || target.owner) return;
    setPasswordTarget(target);
    setNewPassword("");
    setPasswordConfirmation("");
    setPasswordError("");
  }

  async function savePasswordReset() {
    if (!user?.owner || !passwordTarget || passwordBusy) return;
    if (newPassword.length < 12 || newPassword.length > 128) {
      setPasswordError("كلمة المرور يجب أن تتكون من 12 إلى 128 حرفًا.");
      return;
    }
    if (newPassword !== passwordConfirmation) {
      setPasswordError("تأكيد كلمة المرور لا يطابق الكلمة الجديدة.");
      return;
    }
    const target = passwordTarget;
    setPasswordBusy(true);
    setPasswordError("");
    try {
      await api(`/users/${target.id}/password`, {
        method: "POST",
        body: { newPassword },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setPasswordTarget(null);
      setNewPassword("");
      setPasswordConfirmation("");
      setNotice({
        tone: "success",
        text: `تغيّرت كلمة مرور ${target.displayName}، وأُلغيت جلساته السابقة.`,
      });
    } catch (cause) {
      if (guard.isCurrent()) setPasswordError(messageOf(cause));
    } finally {
      if (guard.isCurrent()) setPasswordBusy(false);
    }
  }
  function openEditor(target: User) {
    if (target.owner) return;
    setEditTarget(target);
    setEditDraft({name:target.name,displayName:target.displayName,email:target.email,phone:target.phone,kind:target.kind,editor:target.editor,monitor:target.monitor,suspended:target.suspended,archived:target.archived});
    setEditError("");
  }
  async function saveEditor() {
    if (!editTarget || !editDraft || editBusy) return;
    setEditBusy(true);
    setEditError("");
    try {
      await api(`/users/${editTarget.id}`, {method:"PATCH",body:editDraft,signal:guard.signal});
      if (!guard.isCurrent()) return;
      // Close as soon as the mutation succeeds; table refresh must not hold the dialog open.
      setEditTarget(null);
      setEditDraft(null);
      setNotice({tone:"success",text:`حُفظت تغييرات حساب ${editTarget.displayName}.`});
      void list.refetch();
      if (editTarget.id === user?.id) await reloadSession();
    } catch (cause) { setEditError(messageOf(cause)); }
    finally { setEditBusy(false); }
  }
  const busyIds = useRef(new Set<number>());

  function filter(key: "kind" | "archived", value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("page");
      return next;
    });
  }

  async function change(
    target: User,
    patch: Partial<Pick<User, PublicFlag | "kind">>,
  ) {
    if (target.owner || busyIds.current.has(target.id)) return;
    busyIds.current.add(target.id);
    setSavingIds(new Set(busyIds.current));
    setNotice(null);
    try {
      await api<{ user: User }>(`/users/${target.id}`, {
        method: "PATCH",
        body: patch,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "list" &&
          query.queryKey[1] === user?.id &&
          query.queryKey[2] === "public" &&
          typeof query.queryKey[3] === "string" &&
          query.queryKey[3].split("?")[0] === "/users",
      });
      if (!guard.isCurrent()) return;
      setNotice({
        tone: "success",
        text: `حُفظ تغيير حساب ${target.displayName}.`,
      });
      if (target.id === user?.id) await reloadSession();
    } catch (cause) {
      if (guard.isCurrent())
        setNotice({ tone: "error", text: messageOf(cause) });
    } finally {
      busyIds.current.delete(target.id);
      if (guard.isCurrent()) setSavingIds(new Set(busyIds.current));
    }
  }

  const columns = useMemo<ColumnDef<User, unknown>[]>(() => {
    const valueCell = (title: string, value: string) => (
      <Button
        type="button"
        variant="ghost"
        size="compact"
        className="table-value"
        onClick={() => setFullValue({ title, value })}
        aria-label={`عرض ${title} كاملًا: ${value || "غير مسجل"}`}
      >
        <span className="truncate">{value || "—"}</span>
      </Button>
    );
    const flags: ColumnDef<User, unknown>[] = (
      Object.keys(flagLabels) as PublicFlag[]
    ).map((flag) => ({
      accessorKey: flag,
      header: flagLabels[flag],
      enableSorting: flag === "archived" || flag === "suspended",
      size: flag === "suspended" ? 180 : 110,
      cell: ({ row }) => (
        <Select
          value={String(row.original[flag])}
          aria-label={`${flagLabels[flag]}: ${row.original.displayName}`}
          disabled={row.original.owner || savingIds.has(row.original.id)}
          onChange={(event) => {
            const value = event.target.value === "true";
            if (flag === "archived" && value) setArchiveTarget(row.original);
            else void change(row.original, { [flag]: value });
          }}
        >
          <option value="false">لا</option>
          <option value="true">نعم</option>
        </Select>
      ),
    }));
    return [
      {
        id: "edit", header: "الإجراءات", size: user?.owner ? 235 : 110,
        enableSorting: false,
        cell: ({ row }) => row.original.owner ? "محمي" : (
          <div className="actions">
            <Button type="button" size="compact" variant="secondary"
              onClick={() => openEditor(row.original)}
              disabled={savingIds.has(row.original.id)}>
              تعديل
            </Button>
            {user?.owner && (
              <Button type="button" size="compact" variant="secondary"
                onClick={() => openPasswordDialog(row.original)}
                disabled={savingIds.has(row.original.id)}>
                تغيير كلمة المرور
              </Button>
            )}
          </div>
        ),
      },
      { accessorKey: "id", header: "المعرف", size: 80 },
      {
        accessorKey: "name",
        header: "الاسم",
        size: 180,
        cell: ({ row }) => valueCell("الاسم", row.original.name),
      },
      {
        accessorKey: "displayName",
        header: "اسم الظهور",
        size: 170,
        cell: ({ row }) => valueCell("اسم الظهور", row.original.displayName),
      },
      {
        accessorKey: "email",
        header: "البريد الإلكتروني",
        size: 230,
        cell: ({ row }) => valueCell("البريد الإلكتروني", row.original.email),
      },
      {
        accessorKey: "phone",
        header: "الهاتف",
        size: 150,
        cell: ({ row }) => valueCell("الهاتف", row.original.phone),
      },
      {
        accessorKey: "kind",
        header: "النوع",
        size: 135,
        cell: ({ row }) => (
          <Select
            value={row.original.kind}
            aria-label={`نوع حساب ${row.original.displayName}`}
            disabled={row.original.owner || savingIds.has(row.original.id)}
            onChange={(event) => {
              const kind = userKinds.find(
                (value) => value === event.target.value,
              );
              if (kind) void change(row.original, { kind });
            }}
          >
            {userKinds.map((kind) => (
              <option key={kind} value={kind}>
                {userKindLabels[kind]}
              </option>
            ))}
          </Select>
        ),
      },
      {
        accessorKey: "owner",
        header: "مالك المنصة",
        enableSorting: false,
        size: 120,
        cell: ({ row }) => (row.original.owner ? "نعم · محمي" : "لا"),
      },
      ...flags,
      {
        accessorKey: "createdAt",
        header: "تاريخ الإنشاء",
        size: 190,
        cell: ({ row }) => dateLabel(row.original.createdAt),
      },
    ];
  }, [savingIds, user?.id, queryClient, guard.isCurrent, guard.signal]);

  return (
    <>
      <PageHeader
        title="المستخدمون"
        description="إدارة الهوية العامة فقط؛ صلاحيات الشركة تأتي من الموظف الفعال داخلها."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void list.refetch();
            }}
            disabled={list.loading}
          >
            تحديث
          </Button>
        }
      />
      <Card>
        <div className="table-filters">
          <Field
            label="البحث عن المستخدمين"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو البريد الإلكتروني أو الهاتف"
            maxLength={200}
          />
          <Select
            label="تصفية حسب النوع"
            value={kindFilter}
            onChange={(event) => filter("kind", event.target.value)}
          >
            <option value="">كل الأنواع</option>
            {userKinds.map((kind) => (
              <option key={kind} value={kind}>
                {userKindLabels[kind]}
              </option>
            ))}
          </Select>
          <Select
            label="تصفية حسب الأرشفة"
            value={archiveFilter}
            onChange={(event) => filter("archived", event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="false">غير مؤرشف</option>
            <option value="true">مؤرشف</option>
          </Select>
        </div>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        {list.error && <Notice tone="error">{messageOf(list.error)}</Notice>}
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          loading={list.loading}
          selectionMode="os"
          getRowId={(row) => String(row.id)}
          ariaLabel="جدول المستخدمين العامين"
        />
      </Card>
      <Dialog
        open={Boolean(passwordTarget)}
        onClose={closePasswordDialog}
        title={passwordTarget ? `تغيير كلمة مرور: ${passwordTarget.displayName}` : "تغيير كلمة المرور"}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={passwordBusy}
              onClick={closePasswordDialog}>إلغاء</Button>
            <Button type="button" disabled={passwordBusy || newPassword.length < 12 || newPassword.length > 128 || newPassword !== passwordConfirmation}
              onClick={() => void savePasswordReset()}>
              {passwordBusy ? "جارٍ التغيير…" : "حفظ كلمة المرور"}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <p className="form-full">
            يمكن للمالك تعيين كلمة مرور جديدة لهذا الحساب العام حتى إن لم يكن
            موظفًا في أي شركة. سيتم تسجيل خروج المستخدم من جميع أجهزته.
          </p>
          <Field label="كلمة المرور الجديدة" type="password" autoComplete="new-password"
            value={newPassword} required minLength={12} maxLength={128}
            onChange={(event) => {setNewPassword(event.target.value); setPasswordError("");}} />
          <Field label="تأكيد كلمة المرور" type="password" autoComplete="new-password"
            value={passwordConfirmation} required minLength={12} maxLength={128}
            onChange={(event) => {setPasswordConfirmation(event.target.value); setPasswordError("");}} />
          {newPassword && passwordConfirmation && newPassword !== passwordConfirmation && (
            <Notice tone="error">تأكيد كلمة المرور لا يطابق الكلمة الجديدة.</Notice>
          )}
          {passwordError && <Notice tone="error">{passwordError}</Notice>}
        </div>
      </Dialog>
      <Dialog open={Boolean(editTarget)} onClose={()=>{if(!editBusy){setEditTarget(null);setEditDraft(null);}}} title={editTarget?`تعديل المستخدم: ${editTarget.displayName}`:"تعديل المستخدم"}
        footer={<><Button variant="secondary" disabled={editBusy} onClick={()=>{setEditTarget(null);setEditDraft(null);}}>إلغاء</Button>
        <Button disabled={editBusy||!editDraft} onClick={()=>void saveEditor()}>{editBusy?"جارٍ الحفظ…":"حفظ التعديلات"}</Button></>}>
        {editTarget&&editDraft&&<div className="form-grid">
          <p className="form-full">المعرف: {editTarget.id}</p>
          <Field label="الاسم" value={editDraft.name} required maxLength={120} onChange={event=>setEditDraft({...editDraft,name:event.target.value})}/>
          <Field label="اسم الظهور" value={editDraft.displayName} maxLength={120} onChange={event=>setEditDraft({...editDraft,displayName:event.target.value})}/>
          <Field label="البريد الإلكتروني (اختياري)" type="email" dir="ltr" value={editDraft.email} maxLength={254} onChange={event=>setEditDraft({...editDraft,email:event.target.value})}/>
          <Field label="الهاتف" type="tel" dir="ltr" value={editDraft.phone} maxLength={40} onChange={event=>setEditDraft({...editDraft,phone:event.target.value})}/>
          <Select label="نوع الحساب" value={editDraft.kind} onChange={event=>setEditDraft({...editDraft,kind:event.target.value as User["kind"]})}>
            {userKinds.map(kind=><option key={kind} value={kind}>{userKindLabels[kind]}</option>)}
          </Select>
          {(["editor","monitor","suspended","archived"] as const).map(flag=><Select key={flag} label={flagLabels[flag]} value={String(editDraft[flag])} onChange={event=>setEditDraft({...editDraft,[flag]:event.target.value==="true"})}>
            <option value="false">لا</option><option value="true">نعم</option>
          </Select>)}
          <p className="form-full">ستُسجَّل تغييرات بيانات الحساب في سجل التدقيق. أرشفة الحساب تسحب جلساته النشطة.</p>
          {editError&&<Notice tone="error">{editError}</Notice>}
        </div>}
      </Dialog>
      <Dialog
        open={Boolean(fullValue)}
        onClose={() => setFullValue(null)}
        title={fullValue?.title ?? "القيمة الكاملة"}
      >
        <p className="full-value">{fullValue?.value || "غير مسجل"}</p>
      </Dialog>
      <Dialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="أرشفة الحساب"
        footer={
          <>
            <Button variant="secondary" onClick={() => setArchiveTarget(null)}>
              إلغاء
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (archiveTarget) {
                  const target = archiveTarget;
                  setArchiveTarget(null);
                  void change(target, { archived: true });
                }
              }}
            >
              أرشفة الحساب
            </Button>
          </>
        }
      >
        <p>
          ستُمنع مشاركة حساب {archiveTarget?.displayName} ويُسحب وصوله النشط. لا
          يمكن للإدارة العامة أرشفة مدير عام فعال؛ هذه العملية متاحة لمالك
          المنصة فقط.
        </p>
      </Dialog>
    </>
  );
}

const actionLabels: Record<string, string> = auditActionLabels;
const targetLabels = auditTargetLabels;

export function PublicAuditPage() {
  const { user } = useSession();
  if (!user) return <Navigate to="/login" replace />;
  if (!canReadPublicAudit(user))
    return (
      <Notice tone="error">
        السجل العام متاح للمراقب وإدارة الموقع العام ومالك المنصة.
      </Notice>
    );
  return <AuditList key={user.id} />;
}

function AuditList() {
  const [params, setParams] = useSearchParams();
  const actionFilter = params.get("action") ?? "";
  const filters = new URLSearchParams();
  if (actionFilter) filters.set("action", actionFilter);
  const list = usePagedQuery<AuditEvent>(
    `/audit${filters.size ? `?${filters}` : ""}`,
    "public",
  );
  const [detail, setDetail] = useState<{
    title: string;
    value: string;
    json?: boolean;
  } | null>(null);
  const columns = useMemo<ColumnDef<AuditEvent, unknown>[]>(
    () => [
      { accessorKey: "id", header: "المعرف", size: 80 },
      {
        accessorKey: "createdAt",
        header: "الوقت",
        size: 190,
        cell: ({ row }) => dateLabel(row.original.createdAt),
      },
      {
        accessorKey: "actorName",
        header: "الفاعل",
        size: 180,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            className="table-value"
            onClick={() =>
              setDetail({
                title: "الفاعل",
                value: row.original.actorName || "النظام",
              })
            }
          >
            <span className="truncate">
              {row.original.actorName || "النظام"}
            </span>
          </Button>
        ),
      },
      {
        accessorKey: "action",
        header: "الإجراء",
        size: 200,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            className="table-value"
            onClick={() =>
              setDetail({
                title: "الإجراء المسجل",
                value: `${actionLabels[row.original.action] ?? "إجراء مسجل"}\n${row.original.action}`,
              })
            }
          >
            <span className="truncate">
              {actionLabels[row.original.action] ?? "إجراء مسجل"}
            </span>
          </Button>
        ),
      },
      {
        accessorKey: "targetType",
        header: "نوع السجل",
        size: 120,
        cell: ({ row }) => targetLabels[row.original.targetType] ?? "سجل",
      },
      {
        accessorKey: "targetId",
        header: "معرف السجل",
        size: 110,
        cell: ({ row }) => row.original.targetId ?? "—",
      },
      ...(["before", "after"] as const).map(
        (side): ColumnDef<AuditEvent, unknown> => ({
          accessorKey: side,
          header: side === "before" ? "قبل التغيير" : "بعد التغيير",
          enableSorting: false,
          size: 140,
          cell: ({ row }) =>
            row.original[side] === null ? (
              "لا توجد قيم"
            ) : (
              <Button
                variant="ghost"
                size="compact"
                onClick={() =>
                  setDetail({
                    title: `${side === "before" ? "قبل التغيير" : "بعد التغيير"} · الحدث ${row.original.id}`,
                    value: JSON.stringify(row.original[side], null, 2),
                    json: true,
                  })
                }
                aria-label={`عرض القيم ${side === "before" ? "قبل التغيير" : "بعد التغيير"} للحدث ${row.original.id}`}
              >
                عرض القيم
              </Button>
            ),
        }),
      ),
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="السجل العام"
        description="أحداث عامة موثقة، مع الفاعل والوقت والقيم الفعلية قبل التغيير وبعده."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void list.refetch();
            }}
            disabled={list.loading}
          >
            تحديث
          </Button>
        }
      />
      <Card>
        <div className="table-filters">
          <Field
            label="البحث في السجل العام"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="اسم الفاعل أو رمز الإجراء"
            maxLength={200}
          />
          <Select
            label="تصفية حسب الإجراء"
            value={actionFilter}
            onChange={(event) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                if (event.target.value) next.set("action", event.target.value);
                else next.delete("action");
                next.delete("page");
                return next;
              })
            }
          >
            <option value="">كل الإجراءات</option>
            {publicAuditActions.map((action) => (
              <option key={action} value={action}>
                {actionLabels[action]}
              </option>
            ))}
          </Select>
        </div>
        {list.error && <Notice tone="error">{messageOf(list.error)}</Notice>}
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          loading={list.loading}
          selectionMode="single"
          getRowId={(row) => String(row.id)}
          ariaLabel="جدول السجل العام"
        />
      </Card>
      <Dialog
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.title ?? "تفاصيل الحدث"}
      >
        {detail?.json ? (
          <pre className="json-value" dir="ltr">
            {detail.value}
          </pre>
        ) : (
          <p className="full-value">{detail?.value}</p>
        )}
      </Dialog>
    </>
  );
}

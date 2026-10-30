import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Moon, Palette, Sun } from "lucide-react";
import {
  DEFAULT_APPEARANCE,
  type AppearancePreference,
} from "../../../packages/contracts/src/index";
import { api, ApiFailure, useScopeGuard, useSession } from "./api";
import { clearAppearanceDraft, readAppearanceDraft, rememberRead, saveAppearanceDraft } from "./offline-storage";
import { Button, Dialog, Field, Notice, Select } from "./ui";

const rgb = (hex: string) =>
  [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
const hex = (parts: number[]) =>
  "#" +
  parts
    .map((value) =>
      Math.round(Math.max(0, Math.min(255, value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
function mix(a: string, b: string, weight: number) {
  return hex(
    rgb(a).map((value, index) => value * (1 - weight) + rgb(b)[index] * weight),
  );
}
function luminance(color: string) {
  return rgb(color)
    .map((value) => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}
export function contrastRatio(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function textOn(background: string) {
  return contrastRatio("#ffffff", background) >=
    contrastRatio("#121b24", background)
    ? "#ffffff"
    : "#121b24";
}
function accessible(seed: string, background: string, target = 4.5) {
  if (contrastRatio(seed, background) >= target) return seed;
  const endpoint = textOn(background);
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(seed, endpoint, step / 100);
    if (contrastRatio(candidate, background) >= target) return candidate;
  }
  return endpoint;
}
export type ThemeTokens = Record<string, string>;
export function buildThemeTokens(
  mode: "light" | "dark",
  inputColor: string,
): ThemeTokens {
  const color = /^#[0-9a-fA-F]{6}$/.test(inputColor) ? inputColor : "#176b61";
  const dark = mode === "dark";
  const bg = dark ? "#111a22" : "#f2f5f7";
  const surface = dark ? "#1a2631" : "#ffffff";
  const text = dark ? "#edf2f7" : "#1e2b36";
  const soft = mix(surface, color, dark ? 0.16 : 0.09);
  const primary = accessible(accessible(color, surface), bg);
  const nav = dark ? "#15222c" : "#ffffff";
  const navActive = mix(nav, color, dark ? 0.22 : 0.11);
  const tokens: ThemeTokens = {
    "--bg": bg,
    "--surface": surface,
    "--text": text,
    "--muted": accessible(dark ? "#a2b1c0" : "#5f6e79", surface),
    "--border": mix(surface, color, dark ? 0.35 : 0.23),
    "--primary": primary,
    "--user-accent-color": color,
    "--on-primary": textOn(primary),
    "--soft": soft,
    "--on-soft": accessible(color, soft),
    "--nav": nav,
    "--nav-active": navActive,
    "--on-nav-active": accessible(color, navActive),
    "--focus": accessible(color, surface, 3),
    "--shadow": dark ? "#00000033" : "#2030470c",
    "--table-head": soft,
    "--table-selected": mix(surface, color, dark ? 0.25 : 0.14),
    "--on-table-selected": text,
    "--hover": mix(surface, color, dark ? 0.12 : 0.045),
  };
  const semantic: Record<string, string> = {
    success: "#168252",
    warning: "#976400",
    error: "#c13243",
    info: "#2864b1",
  };
  Object.entries(semantic).forEach(([name, seed]) => {
    const background = mix(surface, seed, dark ? 0.2 : 0.08);
    tokens[`--${name}-bg`] = background;
    tokens[`--${name}-text`] = accessible(seed, background);
    tokens[`--${name}-solid`] = accessible(seed, surface);
    tokens[`--on-${name}`] = textOn(tokens[`--${name}-solid`]);
  });
  return tokens;
}
const defaultPreference: AppearancePreference = DEFAULT_APPEARANCE;
interface AppearanceValue {
  preference: AppearancePreference;
  setPreference: (value: AppearancePreference) => void;
  open: () => void;
}
const AppearanceContext = createContext<AppearanceValue | null>(null);
export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("Appearance missing");
  return value;
}
export function AppearanceProvider({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const { user } = useSession();
  const guard = useScopeGuard(scope);
  const [preference, updatePreference] =
    useState<AppearancePreference>(defaultPreference);
  const [opened, setOpened] = useState(false);
  // Prevent an older request from closing a dialog opened again after dismissal.
  const dialogVersion = useRef(0);
  const openAppearance = () => {
    dialogVersion.current++;
    setNotice(null);
    setOpened(true);
  };
  const closeAppearance = () => {
    dialogVersion.current++;
    setOpened(false);
  };
  const [loading, setLoading] = useState(!!user);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "info" | "success" | "error";
    text: string;
  } | null>(null);
  const revision = useRef(0);
  const [savedRevision, setSavedRevision] = useState(-1);
  const snapshot = useRef(preference);
  snapshot.current = preference;
  const setPreference = (value: AppearancePreference) => {
    revision.current++;
    updatePreference(value);
    setNotice(null);
  };
  useEffect(() => {
    if (!user) return;
    const currentUser=user.id;
    const captured=revision.current;
    const path=`/appearance?scope=${encodeURIComponent(scope)}`;
    void (async () => {
      try {
        // Local unsynchronized changes win over an old server preference.
        const pending=await readAppearanceDraft(currentUser,scope);
        if (pending) {
          if (guard.isCurrent() && revision.current===captured) {
            updatePreference(pending);
            setSavedRevision(captured);
          }
          return;
        }
        const result=await api<{ preference: AppearancePreference }>(path,{signal:guard.signal});
        if (guard.isCurrent() && revision.current===captured) {
          updatePreference(result.preference);
          setSavedRevision(captured);
        }
      } catch (error) {
        if (guard.isCurrent()) setNotice({tone:"error",
          text:error instanceof Error?error.message:"تعذر تحميل المظهر"});
      } finally {
        if(guard.isCurrent()) setLoading(false);
      }
    })();
  }, [scope,user?.id]);
  useEffect(() => {
    if (!user) return;
    const userId=user.id, path=`/appearance?scope=${encodeURIComponent(scope)}`;
    let stopped=false, running=false;
    const refresh=async () => {
      if(stopped || running || !navigator.onLine) return;
      running=true;
      try {
        const draft=await readAppearanceDraft(userId,scope);
        if(draft) {
          await api("/appearance",{method:"PATCH",body:{scope,...draft}});
          await rememberRead(path,{preference:draft});
          await clearAppearanceDraft(userId,scope);
        } else if(revision.current===savedRevision) {
          const result=await api<{preference:AppearancePreference}>(path);
          if(!stopped && guard.isCurrent() && revision.current===savedRevision)
            updatePreference(result.preference);
        }
      } catch {
        // Keep the local draft; retry on reconnection without overwriting
        // the user's currently displayed appearance.
      } finally {running=false;}
    };
    const onOnline=()=>{void refresh();};
    window.addEventListener("online",onOnline);
    return ()=>{stopped=true;window.removeEventListener("online",onOnline);};
  }, [scope,user?.id,savedRevision]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const tokens = buildThemeTokens(preference.mode, preference.color);
    Object.entries(tokens).forEach(([key, value]) =>
      root.style.setProperty(key, value),
    );
    root.dataset.theme = preference.mode;
    root.style.colorScheme = preference.mode;
  }, [preference]);
  const save = async () => {
    if (saving) return;
    const sentVersion = dialogVersion.current;
    const sentRevision = revision.current;
    const sent = { ...snapshot.current };
    setSaving(true);
    setNotice(null);
    try {
      await api("/appearance", {
        method: "PATCH",
        body: { scope, ...sent },
        signal: guard.signal,
      });
      if(user?.id) {
        await rememberRead(`/appearance?scope=${encodeURIComponent(scope)}`,{preference:sent});
        await clearAppearanceDraft(user.id,scope);
      }
      if (!guard.isCurrent()) return;
      setSavedRevision(sentRevision);
      if (revision.current === sentRevision && dialogVersion.current === sentVersion) {
        // The submitted preference was saved and no newer unsaved edit exists.
        setNotice(null);
        closeAppearance();
      } else if (revision.current !== sentRevision && dialogVersion.current === sentVersion) {
        setNotice({
          tone: "info",
          text: "تم حفظ النسخة المرسلة. توجد تغييرات أحدث تحتاج إلى حفظ.",
        });
      }
    } catch (error) {
      const transient=!(error instanceof ApiFailure) || error.status>=500;
      if (transient && user?.id) {
        try {
          await saveAppearanceDraft(user.id,scope,sent);
          await rememberRead(`/appearance?scope=${encodeURIComponent(scope)}`,{preference:sent});
          if (guard.isCurrent()) {
            setSavedRevision(sentRevision);
            if (revision.current===sentRevision && dialogVersion.current===sentVersion)
              closeAppearance();
          }
        } catch(localError) {
          if(guard.isCurrent()) setNotice({tone:"error",
            text:localError instanceof Error?localError.message:"تعذر الحفظ المحلي"});
        }
      } else if(guard.isCurrent())
        setNotice({tone:"error",
          text:error instanceof Error?error.message:"تعذر حفظ المظهر"});
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  };
  return (
    <AppearanceContext.Provider
      value={{ preference, setPreference, open: openAppearance }}
    >
      {children}
      <Dialog
        open={opened}
        onClose={closeAppearance}
        title="مظهر مساحة العمل"
        footer={
          <>
            <span className="muted" data-testid="appearance-revision">
              {!user
                ? "سجّل الدخول لحفظ المظهر"
                : loading
                  ? "جارٍ تحميل إعداداتك…"
                  : revision.current !== savedRevision
                    ? "تغييرات غير محفوظة"
                    : "المظهر محفوظ"}
            </span>
            <Button
              onClick={save}
              disabled={!user || saving || loading}
              data-testid="appearance-save"
            >
              {saving ? "جارٍ الحفظ…" : "حفظ المظهر"}
            </Button>
          </>
        }
      >
        <p className="muted">
          {scope === "public"
            ? "إعداداتك في الموقع العام"
            : "إعداداتك في هذه الشركة"}{" "}
          · لكل حساب ونطاق مظهر مستقل
        </p>
        {loading && <Notice>جارٍ تحميل المظهر…</Notice>}
        <div className="form-grid">
          <Select
            label="نمط المظهر"
            value={preference.mode}
            onChange={(event) =>
              setPreference({
                ...preference,
                mode: event.target.value as "light" | "dark",
              })
            }
            data-testid="appearance-mode"
          >
            <option value="light">فاتح</option>
            <option value="dark">معتم</option>
          </Select>
          <Field
            label="لون المظهر"
            type="color"
            value={preference.color}
            onChange={(event) =>
              setPreference({ ...preference, color: event.target.value })
            }
            data-testid="appearance-color"
          />
        </div>
        <div className="theme-preview">
          <Palette size={18} />
          <span>معاينة اللون والأزرار والتركيز</span>
          <Button variant="secondary">زر ثانوي</Button>
          <Button>زر أساسي</Button>
        </div>
        <div data-testid="appearance-status">
          {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        </div>
      </Dialog>
    </AppearanceContext.Provider>
  );
}
export function AppearanceButton() {
  const appearance = useAppearance();
  return (
    <Button
      variant="ghost"
      onClick={appearance.open}
      aria-label="إعدادات المظهر"
    >
      {appearance.preference.mode === "dark" ? (
        <Moon size={18} />
      ) : (
        <Sun size={18} />
      )}
      <span className="desktop-only">المظهر</span>
    </Button>
  );
}

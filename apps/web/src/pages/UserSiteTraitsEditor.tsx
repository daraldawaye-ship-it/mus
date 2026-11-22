import { useEffect, useRef, useState } from "react";
import {
  userSiteTraits, userSiteTraitLabels, userSiteTraitsResponseSchema,
  type UserSiteTrait, type UserSiteTraitsResponse,
} from "../../../../packages/contracts/src/user-site-traits";
import { api } from "../api";
import { Button, Notice } from "../ui";

export function UserSiteTraitsEditor({ userId }: { userId: number }) {
  const path = `/users/${userId}/site-traits`;
  const [loaded, setLoaded] = useState<UserSiteTraitsResponse | null>(null);
  const [selected, setSelected] = useState<UserSiteTrait[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setLoaded(null);
    setSelected([]);
    setStatus(null);
    void api(path, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const record = userSiteTraitsResponseSchema.parse(result);
      setLoaded(record);
      setSelected(record.traits);
    }).catch(() => {
      if (!controller.signal.aborted) setStatus({ text: "تعذر قراءة الصفات. حاول التحديث.", error: true });
    });
    return () => controller.abort();
  }, [path, attempt]);

  const dirty = !!loaded && (selected.length !== loaded.traits.length || selected.some(trait => !loaded.traits.includes(trait)));
  async function save() {
    const controller = active.current;
    if (!controller || controller.signal.aborted || !loaded || !dirty || busy.current) return;
    busy.current = true;
    setSaving(true);
    setStatus(null);
    try {
      const result = await api(path, {
        method: "PATCH",
        body: { traits: userSiteTraits.filter(trait => selected.includes(trait)), expectedRevision: loaded.revision },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const record = userSiteTraitsResponseSchema.parse(result);
      setLoaded(record);
      setSelected(record.traits);
      setStatus({ text: "حُفظت الصفات.", error: false });
    } catch (cause) {
      if (!controller.signal.aborted) setStatus({
        text: cause instanceof Error ? cause.message : "تعذر حفظ الصفات. حاول التحديث.",
        error: true,
      });
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return <fieldset className="form-full">
    <legend>صفات المستخدم</legend>
    <p className="muted">للتمييز فقط. لا تمنح صلاحية للدردشة أو القضايا أو غيرها.</p>
    {status && <Notice tone={status.error ? "error" : "success"}>{status.text}</Notice>}
    {!loaded && !status && <p role="status">جارٍ تحميل الصفات…</p>}
    {loaded && <div className="actions">
      {userSiteTraits.map(trait => <label key={trait}>
        <input type="checkbox" checked={selected.includes(trait)} disabled={saving} onChange={event => {
          const checked = event.currentTarget.checked;
          setSelected(previous => checked ? [...previous, trait] : previous.filter(value => value !== trait));
        }} /> {userSiteTraitLabels[trait]}
      </label>)}
    </div>}
    <div className="actions">
      {loaded && <Button type="button" disabled={saving || !dirty} onClick={() => void save()}>
        {saving ? "جارٍ الحفظ…" : "حفظ الصفات"}
      </Button>}
      {status?.error && <Button type="button" variant="secondary" disabled={saving} onClick={() => setAttempt(value => value + 1)}>تحديث الصفات</Button>}
    </div>
  </fieldset>;
}

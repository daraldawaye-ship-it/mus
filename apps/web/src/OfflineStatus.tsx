import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { offlineChanged, pendingForUser, rememberRead, syncPending } from "./offline-storage";
import { Button, Notice } from "./ui";

export function OfflineStatus({ userId, companyId }: { userId: number; companyId?: number }) {
  const client = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const refresh = () => { void pendingForUser(userId).then(rows => setPending(rows.length)).catch(() => {}); };
    refresh();
    const detach = offlineChanged(refresh);
    const connected = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void syncPending(userId,
        (path, body) => api(path, { method: "POST", body }))
        .then(result => {
          if (result.saved) {
            setMessage("تزامنت " + result.saved + " عملية. جرى تحديث بيانات الصفحات.");
            void client.invalidateQueries();
          }
          if (result.failed) setMessage("بقيت عملية محفوظة محليًا؛ راجع سبب رفض الخادم.");
        }).catch(() => {});
    };
    connected();
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    return () => {
      detach();
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", connected);
    };
  }, [userId, client]);
  async function sync() {
    if (busy || !navigator.onLine) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await syncPending(userId, (path, body) => api(path, { method: "POST", body }));
      if (result.saved) await client.invalidateQueries();
      setMessage(result.failed
        ? "تعذر قبول عملية. ستبقى محفوظة للمراجعة."
        : result.saved ? "تزامنت " + result.saved + " عملية." : "لا توجد عمليات جديدة.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذرت المزامنة");
    } finally { setBusy(false); }
  }
  async function downloadCatalog() {
    if (!companyId || !navigator.onLine || downloading) return;
    setDownloading(true);
    setProgress("");
    setMessage("");
    let total = 0;
    let complete = true;
    for (const type of ["items", "accounts", "branches", "locations", "currencies"]) {
      let page = 1;
      while (page <= 200 && navigator.onLine) {
        const params = new URLSearchParams({
          type, active: "true", page: String(page), pageSize: "100",
        });
        const path = "/companies/" + companyId + "/commerce-options?" + params.toString();
        try {
          const result = await api<{ items: unknown[]; total?: number }>(path);
          await rememberRead(path, result);
          total += result.items.length;
          setProgress("حُفظ محليًا: " + total + " سجل");
          if (result.items.length < 100 ||
            (typeof result.total === "number" && page * 100 >= result.total)) break;
          page++;
        } catch {
          complete = false;
          break; // Permission to view one kind is not permission to view another.
        }
      }
      if (page > 200) complete = false;
    }
    setDownloading(false);
    setProgress("");
    setMessage((complete ? "اكتمل الحفظ المحلي لما أمكن قراءته: " : "حفظ جزئي: ") +
      total + " سجل. النسخة لا تغيّر قاعدة البيانات الرئيسية.");
  }
  return <section className="offline-status" aria-label="العمل بدون إنترنت">
    <div className="form-actions">
      <span role="status">{online ? "متصل" : "بدون إنترنت"}</span>
      <span>بانتظار المزامنة: <strong>{pending}</strong></span>
      {companyId && <Button variant="secondary" disabled={!online || downloading}
        onClick={() => void downloadCatalog()}>
        {downloading ? "جارٍ تحديث النسخة المحلية…" : "تحديث الأصناف والحسابات لهذا الجهاز"}
      </Button>}
      {pending > 0 && <Button variant="secondary" disabled={!online || busy} onClick={() => void sync()}>
        {busy ? "جارٍ التحقق…" : "مزامنة المحفوظات"}
      </Button>}
    </div>
    {progress && <small role="status">{progress}</small>}
    {message && <Notice>{message}</Notice>}
    {!online && <small className="muted">النسخة المحلية للعرض فقط؛ الأسعار والمخزون قد تتغير. السندات والفواتير غير مرحلة حتى إقرار الخادم.</small>}
  </section>;
}

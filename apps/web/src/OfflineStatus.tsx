import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { applyItemChanges, itemChangeCursor, offlineChanged, pendingForUser, rememberRead, syncPending, type ItemChangeCursor } from "./offline-storage";
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

  useEffect(() => {
    if (!companyId) return;
    let stopped = false;
    let running = false;
    let lastPollAt = 0;
    let repeatAfterCurrent = false;
    const channel = typeof BroadcastChannel === "undefined" ? null :
      new BroadcastChannel("alraesy-items-" + userId + "-" + companyId);
    const invalidateItems = () => void client.invalidateQueries({
      predicate: query => {
        const key = query.queryKey;
        return key.includes(userId) && key.includes(companyId) &&
          /item|commerce|master/i.test(JSON.stringify(key));
      },
    });
    if (channel) channel.onmessage = event => {
      if (event.data === "changed") invalidateItems();
    };
    async function poll() {
      if (stopped || running || !navigator.onLine || document.visibilityState === "hidden") return;
      running = true;
      lastPollAt = Date.now();
      try {
        let cursor: ItemChangeCursor | null = await itemChangeCursor(userId, companyId!);
        let changed = false;
        for (let page = 0; page < 5 && !stopped; page++) {
          const qs = new URLSearchParams();
          if (cursor) {
            qs.set("since", cursor.since);
            qs.set("afterId", String(cursor.afterId));
          }
          const response = await api<{
            items: Record<string, unknown>[];
            cursor: ItemChangeCursor;
            hasMore: boolean;
          }>("/companies/" + companyId + "/item-changes" + (qs.size ? "?" + qs : ""));
          if (stopped) break;
          await applyItemChanges(userId, companyId!, response.items, response.cursor);
          if (response.items.length) changed = true;
          cursor = response.cursor;
          if (!response.hasMore) break;
        }
        if (changed && !stopped) {
          invalidateItems();
          channel?.postMessage("changed");
        }
      } catch {
        // Network or permission failure is not evidence of an empty change feed.
        // Keep the last committed cursor and retry on focus/connection.
      } finally {
        running = false;
        if (repeatAfterCurrent && !stopped) {
          repeatAfterCurrent = false;
          void poll();
        }
      }
    }
    // Limit routine reads to once every two minutes. A confirmed invoice
    // reset bypasses the interval because the next invoice needs fresh cards.
    const connected = () => {
      if (Date.now() - lastPollAt >= 120_000) void poll();
    };
    const afterInvoiceReset = (event: Event) => {
      if (!(event instanceof CustomEvent) || Number(event.detail?.companyId) !== companyId) return;
      if (running) {
        repeatAfterCurrent = true;
      } else {
        void poll();
      }
    };
    const timer = window.setInterval(connected, 120_000);
    window.addEventListener("online", connected);
    window.addEventListener("alraesy-invoice-reset", afterInvoiceReset);
    window.addEventListener("focus", connected);
    document.addEventListener("visibilitychange", connected);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("online", connected);
      window.removeEventListener("alraesy-invoice-reset", afterInvoiceReset);
      window.removeEventListener("focus", connected);
      document.removeEventListener("visibilitychange", connected);
      channel?.close();
    };
  }, [companyId, userId, client]);
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

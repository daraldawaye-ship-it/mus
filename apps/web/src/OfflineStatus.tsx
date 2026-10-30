import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { applyItemChanges, catalogDownloadState, itemChangeCursor, offlineChanged, pendingForUser, rememberCatalogBatch, rememberRead, readCatalogProgress, saveCatalogProgress, syncPending, type ItemChangeCursor } from "./offline-storage";
import { Button, Notice } from "./ui";
import { isAppWindow } from "./app-install";

type DeviceProps = { userId: number; companyId?: number };
export function OfflineStatus({ userId, companyId }: DeviceProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [primary, setPrimary] = useState(false);
  useEffect(() => {
    // Some old navigation render paths keep stale setup sections in the DOM.
    // Elect one live panel; only that panel may poll or start downloads.
    const choose = () => {
      const entries = Array.from(document.querySelectorAll<HTMLElement>("[data-alraesy-offline-instance]"));
      const chosen = entries.filter(entry => !!entry.dataset.companyId).at(-1) ?? entries.at(-1);
      setPrimary(wasPrimary => {
        const next = chosen === holder.current;
        return wasPrimary === next ? wasPrimary : next;
      });
    };
    const observer = new MutationObserver(choose);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-company-id"] });
    choose();
    return () => observer.disconnect();
  }, [userId, companyId]);
  return <div ref={holder} data-alraesy-offline-instance="" data-company-id={companyId ?? ""}>
    {primary && <OfflineStatusBody userId={userId} companyId={companyId} />}
  </div>;
}

type CatalogUiState = { key: string; busy: boolean; progress: string; message: string };
let activeCatalogDownload: Promise<void> | null = null;
let catalogUi: CatalogUiState = { key: "", busy: false, progress: "", message: "" };
const CATALOG_EVENT = "alraesy-catalog-download-progress";
function publishCatalogStatus(patch: Partial<CatalogUiState>) {
  catalogUi = { ...catalogUi, ...patch };
  window.dispatchEvent(new Event(CATALOG_EVENT));
}
function OfflineStatusBody({ userId, companyId }: DeviceProps) {
  const client = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const scopeKey = userId + ":" + (companyId ?? "");
  const [downloading, setDownloading] = useState(catalogUi.key === scopeKey && catalogUi.busy);
  const [progress, setProgress] = useState(catalogUi.key === scopeKey ? catalogUi.progress : "");
  const [message, setMessage] = useState(catalogUi.key === scopeKey ? catalogUi.message : "");
  useEffect(() => {
    const update = () => {
      if (catalogUi.key !== scopeKey) return;
      setDownloading(catalogUi.busy);
      setProgress(catalogUi.progress);
      setMessage(catalogUi.message);
    };
    update();
    window.addEventListener(CATALOG_EVENT, update);
    return () => window.removeEventListener(CATALOG_EVENT, update);
  }, [scopeKey]);
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
  function downloadCatalog() {
    if (!companyId || !navigator.onLine || activeCatalogDownload) return;
    const key = scopeKey;
    publishCatalogStatus({ key, busy: true, progress: "", message: "" });
    activeCatalogDownload = (async () => {
      let savedItems = 0;
      let otherRecords = 0;
      try {
        const prior = await catalogDownloadState(userId, companyId);
        savedItems = prior?.count ?? 0;
        if (!prior?.complete) {
          // Full initial item catalog goes through the indexed, cheap change
          // feed, not the expensive invoice search/ranking endpoint.
          let cursor: ItemChangeCursor = prior?.cursor ?? {
            since: "1970-01-01T00:00:00.000Z", afterId: 0,
          };
          let complete = false;
          for (let page = 0; page < 40; page++) {
            if (!navigator.onLine) throw new Error("انقطع الاتصال أثناء التنزيل");
            const params = new URLSearchParams({
              since: cursor.since, afterId: String(cursor.afterId),
            });
            const response = await api<{
              items: Record<string, unknown>[]; cursor: ItemChangeCursor; hasMore: boolean;
            }>("/companies/" + companyId + "/item-changes?" + params.toString());
            savedItems += response.items.length;
            // The saved cursor makes a reload resume from the last committed batch.
            await rememberCatalogBatch(
              userId, companyId, response.items, response.cursor, savedItems, !response.hasMore,
            );
            cursor = response.cursor;
            publishCatalogStatus({ progress: "الأصناف المحفوظة: " + savedItems + " — جارٍ الاستكمال…" });
            if (!response.hasMore) { complete = true; break; }
          }
          if (!complete) throw new Error("وصل التنزيل إلى حد الدفعات؛ يمكنك الاستكمال بالضغط مجددًا");
        } else {
          publishCatalogStatus({ progress: "الأصناف محفوظة: " + savedItems + " — جارٍ تحديث بقية البيانات…" });
        }
        // Small reference catalogs use their ordinary permitted endpoints.
        for (const type of ["accounts", "branches", "locations", "currencies"]) {
          const checkpoint = await readCatalogProgress(userId, companyId, "option:" + type);
          if (checkpoint.complete) continue;
          let finished = false;
          for (let page = checkpoint.nextPage; page < checkpoint.nextPage + 40; page++) {
            if (!navigator.onLine) throw new Error("انقطع الاتصال أثناء التنزيل");
            const params = new URLSearchParams({
              type, active: "true", page: String(page), pageSize: "100",
            });
            const path = "/companies/" + companyId + "/commerce-options?" + params.toString();
            const response = await api<{ items: unknown[]; total?: number }>(path);
            await rememberRead(path, response);
            otherRecords += response.items.length;
            const done = response.items.length < 100 ||
              (typeof response.total === "number" && page * 100 >= response.total);
            await saveCatalogProgress(userId, companyId, "option:" + type, page + 1, done);
            publishCatalogStatus({ progress: "الأصناف: " + savedItems + "، الحسابات والخيارات: " + otherRecords });
            if (response.items.length < 100 ||
              (typeof response.total === "number" && page * 100 >= response.total)) {
              finished = true; break;
            }
          }
          if (!finished) throw new Error("لم يكتمل تنزيل " + type + "؛ اضغط مجددًا للاستكمال");
        }
        publishCatalogStatus({
          message: "اكتمل حفظ " + savedItems + " صنف و" + otherRecords +
            " سجل مساعد. ستتحدث أسماء الأصناف وأسعارها بالتغييرات اللاحقة.",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "تعذر تنزيل البيانات";
        publishCatalogStatus({
          message: "لم يكتمل التنزيل؛ حُفظ " + savedItems +
            " صنف حتى الآن، ويمكن استكمال البقية دون إعادة تنزيلها. السبب: " + reason,
        });
      } finally {
        publishCatalogStatus({ busy: false, progress: "" });
      }
    })().finally(() => { activeCatalogDownload = null; });
  }
  // Keep item-delta polling and pending operations in both modes.
  // Browser pages need no catalog download toolbar.
  if (!isAppWindow()) return null;
  return <section className="offline-status" aria-label="العمل بدون إنترنت">
    <div className="form-actions">
      <span role="status">{online ? "متصل" : "بدون إنترنت"}</span>
      <span>بانتظار المزامنة: <strong>{pending}</strong></span>
      {companyId && <Button variant="secondary" disabled={!online || downloading}
        onClick={() => void downloadCatalog()}>
        {downloading ? "جارٍ حفظ البيانات على الجهاز…" : "تنزيل/تحديث بيانات الجهاز"}
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

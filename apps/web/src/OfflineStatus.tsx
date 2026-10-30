import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { applyItemChanges, itemChangeCursor, offlineChanged, offlineUser, pendingForUser, rememberRead, syncPending, type ItemChangeCursor } from "./offline-storage";
import { Button, Notice } from "./ui";
import { isAppWindow } from "./app-install";
import { isOfflineNow, subscribeConnection } from "./connection-mode";
import { syncMyHistory } from "./offline-my-history";
import { syncOfflineQuestionPack } from "./offline-question-pack";
import { refreshDailySaleRanks } from "./offline-sale-rank-sync";
import { downloadSharedReferenceCards } from "./offline-shared-master";
import { refreshSharedCompositions, refreshSharedQuestions } from "./offline-shared-extra";
import { readSharedItemProgress, saveSharedItemBatch, refreshSharedItemCards } from "./offline-shared-items";
import { migrateExistingCatalog } from "./offline-shared-migrate";

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
let catalogRetryTimer: number | null = null;
let catalogUi: CatalogUiState = { key: "", busy: false, progress: "", message: "" };
const CATALOG_EVENT = "alraesy-catalog-download-progress";
function publishCatalogStatus(patch: Partial<CatalogUiState>) {
  catalogUi = { ...catalogUi, ...patch };
  window.dispatchEvent(new Event(CATALOG_EVENT));
}
function OfflineStatusBody({ userId, companyId }: DeviceProps) {
  const client = useQueryClient();
  const [online, setOnline] = useState(!isOfflineNow());
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
      setOnline(!isOfflineNow());
      if (!isOfflineNow()) void syncPending(userId,
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
    const unsubscribeConnection=subscribeConnection(connected);
    return () => {
      detach();
      unsubscribeConnection();
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
      if (stopped || running || isOfflineNow() || document.visibilityState === "hidden") return;
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
          await refreshSharedItemCards(userId, companyId!, response.items);
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
    if (busy || isOfflineNow()) return;
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
  function scheduleNextBatch() {
    if (catalogRetryTimer !== null) return;
    catalogRetryTimer = window.setTimeout(() => {
      catalogRetryTimer = null;
      if (offlineUser() === userId && !isOfflineNow() && isAppWindow() &&
          document.visibilityState !== "hidden" &&
          window.location.pathname.startsWith("/companies/" + companyId)) {
        downloadCatalog();
      }
    }, 5_000);
  }
  function downloadCatalog() {
    if (!companyId || isOfflineNow() || activeCatalogDownload || offlineUser() !== userId) return;
    const key = scopeKey;
    publishCatalogStatus({ key, busy: true, progress: "", message: "" });
    const transfer = async () => {
      let savedItems = 0;
      let otherRecords = 0;
      try {
        let itemPermission = false;
        try {
          await api("/companies/" + companyId + "/item-changes");
          itemPermission = true;
        } catch { /* no item permission: do not read shared items */ }
        if (itemPermission) await migrateExistingCatalog(userId, companyId).catch(() => {});
        const prior = itemPermission ?
          await readSharedItemProgress(userId, companyId) : { complete:true,count:0,
            cursor:{ since:"1970-01-01T00:00:00.000Z",afterId:0 } };
        savedItems = prior?.count ?? 0;
        if (!prior?.complete) {
          // Full initial item catalog goes through the indexed, cheap change
          // feed, not the expensive invoice search/ranking endpoint.
          let cursor: ItemChangeCursor = prior?.cursor ?? {
            since: "1970-01-01T00:00:00.000Z", afterId: 0,
          };
          let complete = false;
          for (let page = 0; page < 40; page++) {
            if (isOfflineNow()) throw new Error("انقطع الاتصال أثناء التنزيل");
            const params = new URLSearchParams({
              since: cursor.since, afterId: String(cursor.afterId),
            });
            const response = await api<{
              items: Record<string, unknown>[]; cursor: ItemChangeCursor; hasMore: boolean;
            }>("/companies/" + companyId + "/item-changes?" + params.toString());
            savedItems += response.items.length;
            // The saved cursor makes a reload resume from the last committed batch.
            await saveSharedItemBatch(
              userId, companyId, response.items, {
                cursor:response.cursor,count:savedItems,complete:!response.hasMore,
              },
            );
            cursor = response.cursor;
            publishCatalogStatus({ progress: "الأصناف المحفوظة: " + savedItems + " — جارٍ الاستكمال…" });
            if (!response.hasMore) { complete = true; break; }
          }
          if (!complete) { scheduleNextBatch(); return; }
        } else {
          publishCatalogStatus({ progress: "الأصناف محفوظة: " + savedItems + " — جارٍ تحديث بقية البيانات…" });
        }
        await refreshSharedCompositions(userId, companyId).catch(() => {});
        await refreshSharedQuestions(userId, companyId).catch(() => {});
        await downloadSharedReferenceCards(userId, companyId);
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
    };
    // One company/user catalog download at a time across open app windows.
    activeCatalogDownload = (async () => {
      if ("locks" in navigator && navigator.locks) {
        await navigator.locks.request("alraesy-catalog:" + key,
          { ifAvailable: true }, async lock => { if (lock) await transfer(); });
      } else await transfer();
    })().finally(() => {
      activeCatalogDownload = null;
      publishCatalogStatus({ busy: false, progress: "" });
    });
  }
  useEffect(() => {
    if (!companyId || !isAppWindow()) return;
    const resume = () => {
      if (!isOfflineNow() && document.visibilityState !== "hidden") downloadCatalog();
    };
    const timer = window.setInterval(resume, 120_000);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      window.clearInterval(timer);
      if (catalogRetryTimer !== null) {
        window.clearTimeout(catalogRetryTimer);
        catalogRetryTimer = null;
      }
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [userId, companyId]);
  // Preload current user's own answer keys and question cards (not shared)
  // both in a browser and in the installed app for offline grading.
  useEffect(() => {
    const warm = () => {
      if (isOfflineNow() || document.visibilityState === "hidden") return;
      void syncOfflineQuestionPack(userId,null).catch(() => {});
      if (companyId) void syncOfflineQuestionPack(userId,companyId).catch(() => {});
    };
    warm();
    const interval=window.setInterval(warm,120_000);
    window.addEventListener("online",warm);
    document.addEventListener("visibilitychange",warm);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online",warm);
      document.removeEventListener("visibilitychange",warm);
    };
  },[userId,companyId]);
  useEffect(() => {
    if (!isAppWindow()) return;
    const refresh = () => {
      if (!isOfflineNow() && document.visibilityState !== "hidden")
        void syncMyHistory(userId,companyId??null);
    };
    const timer = window.setInterval(refresh,120_000);
    window.addEventListener("online",refresh);
    refresh();
    return () => { window.clearInterval(timer); window.removeEventListener("online",refresh); };
  },[userId,companyId]);
  useEffect(() => {
    if(!companyId || !isAppWindow())return;
    const run=()=>{
      if(!isOfflineNow() && document.visibilityState!=="hidden")
        void refreshDailySaleRanks(userId,companyId);
    };
    run();
    const timer=window.setInterval(run,120_000);
    window.addEventListener("online",run);
    document.addEventListener("visibilitychange",run);
    return ()=>{
      window.clearInterval(timer);
      window.removeEventListener("online",run);
      document.removeEventListener("visibilitychange",run);
    };
  },[userId,companyId]);
  // Downloads and queued financial operations continue without any visible button.
  // Older render trees may still contain a toolbar; styling hides those as well.
  // Keep all existing UI logic mounted for backward compatibility.
  // Keep item-delta polling and pending operations in both modes.
  // Browser pages need no catalog download toolbar.
  if (!isAppWindow()) return null;
  return null;
}

import { useSyncExternalStore } from "react";
import { connectionSnapshot, subscribeConnection } from "./connection-mode";
import { useMarketReadStatus } from "./market-query";
import { getMarketCacheScopeError, subscribeMarketCache } from "./market-offline";

const subscribeScope = (notify: () => void) => subscribeMarketCache(event => {
  if (event.type === "scope" || event.type === "cleared") notify();
});

const formatTime = (value: number) => new Intl.DateTimeFormat("ar-YE", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Aden",
}).format(new Date(value));

/** Compact provenance for local prices and incomplete downloads. */
export function MarketOfflineStatus({ path, detail = false }: { path: string; detail?: boolean }) {
  const state = useMarketReadStatus(path);
  const scopeError = useSyncExternalStore(subscribeScope, getMarketCacheScopeError, () => null);
  const connection = useSyncExternalStore(subscribeConnection, connectionSnapshot, () => "online");
  if (scopeError) return <p className="market-offline-status is-unavailable" role="status">
    <span>{scopeError}</span>
    <button type="button" className="medicine-market-link" onClick={() => window.location.reload()}>
      إعادة تحميل
    </button>
  </p>;
  if (!state) return null;
  const offline = connection !== "online";
  if (state.source === "missing") return <p className="market-offline-status is-unavailable">
    {state.error ?? "هذه البيانات غير محفوظة على الجهاز؛ يلزم اتصال لتحميلها."}
  </p>;
  const checked = state.checkedAt ?? state.savedAt;
  return <p className={`market-offline-status${offline ? " is-offline" : ""}`}
    data-market-cache-source={state.source} data-market-cache-partial={state.partial || undefined}>
    {(offline || state.source === "saved") && <span>المحفوظ على هذا الجهاز</span>}
    {offline && <span>دون إنترنت · للعرض فقط</span>}
    {checked !== null && <span>آخر تحقق: <time dateTime={new Date(checked).toISOString()}>
      {formatTime(checked)}
    </time></span>}
    {!offline && state.refreshing && <span>جارٍ التحقق من التحديثات…</span>}
    {state.partial && <span>{detail
      ? "نسخة جزئية؛ قد توجد تفاصيل أو تعليقات لم تُحمّل أو تُحدّث بعد."
      : "نتائج من الكروت المحفوظة فقط."}</span>}
    {!!state.error && <span>{state.error}</span>}
  </p>;
}

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, Heart, MessageCircle, Star } from "lucide-react";
import { marketRelationKeys, marketRelationLabels, type MarketCard, type MarketDetail } from "../../../../packages/contracts/src/medicine-market";
import { api } from "../api";
import { interestCollectionEnabled } from "../InterestTracker";
import { useMarketCacheScope, useMarketOffline } from "../market-query";

export function MarketCardCounts({card, compact = false}: {card: MarketCard; compact?: boolean}) {
  const stats = card.statistics;
  if (!stats) return null;
  return <span className={compact ? "market-counts compact" : "market-counts"}>
    <span title="مرات الفتح"><Eye size={14}/>{stats.opens}<span className={compact ? "sr-only" : ""}> فتحات</span></span>
    <span title="التعليقات المعتمدة"><MessageCircle size={14}/>{stats.comments}<span className={compact ? "sr-only" : ""}> تعليقات معتمدة</span></span>
    <span title="الإعجابات"><Heart size={14}/>{card.likes}<span className={compact ? "sr-only" : ""}> إعجابات</span></span>
    <span title={stats.ratingCount
      ? `متوسط التقييم ${stats.ratingAverage?.toFixed(1) ?? "—"} من 5، من ${stats.ratingCount} تقييم`
      : "لا توجد تقييمات بعد"}>
      <Star size={14}/>
      {stats.ratingCount ? `${stats.ratingAverage?.toFixed(1) ?? "—"}/5` : "—"}
      <span>{compact ? ` (${stats.ratingCount})` : ` · ${stats.ratingCount} تقييم`}</span>
    </span>
    {marketRelationKeys[card.kind]?.filter(key => (key !== "alternatives" && (key !== "manufacturers" || card.kind !== "agent")) || stats.relations[key] != null).map(key =>
      <span key={key} title={key === "alternatives" ? "الأصناف الأخرى المرتبطة بكرت التركيب نفسه" : undefined}>{marketRelationLabels[key]} {stats.relations[key] ?? 0}</span>)}
  </span>;
}

/** Mount only for the displayed detail. List/lookup GETs and polling cannot record opens. */
export function RecordMarketCardOpen({cardId,userId}: {cardId: number;userId: number}) {
  const client = useQueryClient();
  const scope = useMarketCacheScope();
  const offline = useMarketOffline();
  const requestKey = useRef<string | null>(null);
  useEffect(() => {
    let sent = false;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const submit = async (attempt = 0) => {
      if (stopped || offline || scope === null || !interestCollectionEnabled() || document.visibilityState !== "visible") return;
      requestKey.current ??= crypto.randomUUID();
      try {
        const {opens} = await api<{opens: number}>(`/medicine-market/cards/${cardId}/open`, {
          method: "POST", body: {idempotencyKey: requestKey.current}, signal: controller.signal,
        });
        if (stopped) return;
        client.setQueriesData<MarketDetail>({queryKey:["medicine-market", userId, "card", cardId],
          predicate: query => query.queryKey.at(-1) === scope}, old =>
          old?.card.statistics ? {...old,card:{...old.card, statistics:{...old.card.statistics,opens}}} : old);
        client.setQueriesData<{items: MarketCard[]}>({queryKey:["medicine-market",userId,"cards"],
          predicate: query => query.queryKey.at(-1) === scope}, page =>
          page?.items.some(item => item.id === cardId && item.statistics)
            ? {...page,items:page.items.map(item => item.id === cardId && item.statistics
              ? {...item,statistics:{...item.statistics,opens}} : item)} : page);
      } catch {
        if (!stopped && attempt < 2) retry = setTimeout(() => {
          if (document.visibilityState !== "visible") sent = false;
          else void submit(attempt+1);
        }, 1500 * (attempt+1));
      }
    };
    const whenVisible = () => {
      if (!sent && document.visibilityState === "visible") { sent = true; void submit(); }
    };
    whenVisible();
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      stopped = true; controller.abort(); clearTimeout(retry);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [cardId,userId,client,scope,offline]);
  return null;
}

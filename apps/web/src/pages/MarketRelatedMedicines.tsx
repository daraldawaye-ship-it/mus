import { useEffect, useId, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MarketCard, MarketKind, MarketMeta, MarketReferenceEntry, MarketRelatedMedicinesPage } from "../../../../packages/contracts/src/medicine-market";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice } from "../ui";
import { MarketCompactCard } from "./MarketCatalogSections";

const titles: Partial<Record<MarketKind, string>> = {
  agent: "أصناف الوكيل",
  manufacturer: "أصناف الشركة المصنّعة",
  composition: "أصناف التركيب",
  medicine: "بدائل نفس التركيب",
};

export function MarketRelatedMedicines({ card, medicineType, references, onOpen }: {
  card: MarketCard;
  medicineType?: MarketMeta["types"][number];
  references: MarketReferenceEntry[];
  onOpen: (id: number) => void;
}) {
  const { user } = useSession();
  const titleId = useId();
  const loadMore = useRef<HTMLDivElement>(null);
  const title = titles[card.kind];
  const list = useInfiniteQuery({
    queryKey: ["medicine-market", user?.id, "related-medicines", card.id, card.revision],
    queryFn: ({ pageParam, signal }) => api<MarketRelatedMedicinesPage>(
      `/medicine-market/cards/${card.id}/related-medicines${pageParam === null ? "" : `?cursor=${pageParam}`}`,
      { signal },
    ),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextCursor,
    enabled: !!title,
  });
  const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError } = list;
  useEffect(() => {
    if (!loadMore.current || !hasNextPage || isFetching || isFetchNextPageError ||
        typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        observer.disconnect();
        void fetchNextPage({ cancelRefetch: false });
      }
    }, { rootMargin: "160px" });
    observer.observe(loadMore.current);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetching, isFetchNextPageError, card.id]);

  if (!title) return null;
  const items = list.data?.pages.flatMap(page => page.items) ?? [];
  return (
    <Card className="market-related-medicines">
      <section aria-labelledby={titleId}>
        <header className="market-catalog-section-heading">
          <h2 id={titleId}>{title}</h2>
        </header>
        {list.isPending && <Notice>جارٍ تحميل الأصناف…</Notice>}
        {!!list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
        {list.isLoadingError && (
          <Button size="compact" variant="secondary" disabled={isFetching}
            onClick={() => void list.refetch()}>إعادة المحاولة</Button>
        )}
        {list.isSuccess && items.length === 0 && (
          <p className="market-section-empty">
            {card.kind !== "medicine" ? "لا توجد أصناف مرتبطة." :
              card.data.compositionId ? "لا توجد أصناف أخرى مرتبطة بنفس التركيب." :
              "لم يُربط هذا الصنف بتركيب بعد."}
          </p>
        )}
        {items.length > 0 && (
          <div className="market-compact-list">
            {items.map(item => <MarketCompactCard key={item.id} item={item}
              type={medicineType} references={references} onOpen={onOpen} />)}
          </div>
        )}
        {hasNextPage && (
          <div ref={loadMore} className="market-catalog-section-footer">
            <Button size="compact" variant="secondary" disabled={isFetching}
              onClick={() => void fetchNextPage({ cancelRefetch: false })}>
              {list.isFetchingNextPage ? "جارٍ تحميل المزيد…" :
                isFetchNextPageError ? "إعادة المحاولة" : "عرض المزيد"}
            </Button>
          </div>
        )}
      </section>
    </Card>
  );
}

import assert from "node:assert/strict";
import test from "node:test";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { mergeMarketPageUpdates } from "../apps/web/src/market-query-pages.ts";

type Page = { items: { id: number; price: number }[]; nextCursor: number | null };
const path = (cursor: number | null) => `/medicine-market/cards/1/related-medicines${cursor === null ? "" : `?cursor=${cursor}`}`;

async function finishRefetchWithBackgroundUpdate(fresh: Page) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["medicine-market", "race"] as const;
  const first: Page = { items: [{ id: 10, price: 100 }], nextCursor: 9 };
  const second: Page = { items: [{ id: 8, price: 200 }], nextCursor: null };
  client.setQueryData<InfiniteData<Page, number | null>>(key, {
    pages: [first, second], pageParams: [null, 9],
  });
  let release!: (value: Page) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Promise<Page>(resolve => { release = resolve; });
  const observer = new InfiniteQueryObserver<Page, Error, InfiniteData<Page, number | null>, typeof key, number | null>(client, {
    queryKey: key, initialPageParam: null, enabled: false,
    queryFn: async ({ pageParam }) => {
      if (pageParam === null) return first;
      started();
      return delayed;
    },
    getNextPageParam: page => page.nextCursor,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const fetching = observer.refetch();
    await entered;
    const pending = new Map([[path(null), fresh]]);
    client.setQueryData<InfiniteData<Page, number | null>>(key, current =>
      mergeMarketPageUpdates(current, pending, path));
    assert.equal(client.getQueryData<InfiniteData<Page>>(key)!.pages[0].items[0].price, fresh.items[0].price);
    release(second);
    await fetching;
    // TanStack has just assembled the array from its earlier page reads.
    // The hook applies the updates retained while that request was running.
    client.setQueryData<InfiniteData<Page, number | null>>(key, current =>
      mergeMarketPageUpdates(current, pending, path));
    return client.getQueryData<InfiniteData<Page, number | null>>(key)!;
  } finally {
    unsubscribe();
    client.clear();
  }
}

test("a late infinite refetch cannot overwrite a newer price from the background", async () => {
  const result = await finishRefetchWithBackgroundUpdate({ items: [{ id: 10, price: 120 }], nextCursor: 9 });
  assert.deepEqual(result.pages.map(page => page.items[0].price), [120, 200]);
  assert.deepEqual(result.pageParams, [null, 9]);
});

test("a newer first-page boundary removes the obsolete tail after refetch completes", async () => {
  const result = await finishRefetchWithBackgroundUpdate({ items: [{ id: 12, price: 150 }], nextCursor: 11 });
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].items[0].id, 12);
  assert.equal(result.pages[0].nextCursor, 11);
  assert.deepEqual(result.pageParams, [null]);
});

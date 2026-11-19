import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCard } from "../packages/contracts/src/medicine-market.ts";
import { reconcileSavedMarketCards } from "../apps/web/src/market-offline.ts";

function card(revision: number, price: string, likes = 0): MarketCard {
  return { id: 145, kind: "medicine", name: "دواء محفوظ", data: { defaultSalePrice: price, englishName: "Saved medicine" },
    status: "published", archived: false, revision, createdAt: "2026-11-19T00:00:00Z",
    updatedAt: "2026-11-19T00:00:00Z", likes, ratingAverage: null, ratingCount: 0,
    myLiked: false, myRating: null, createdBy: 1 };
}
const times = { scope: "guest", savedAt: 100, checkedAt: 100, requestedAt: 90, etag: '"old-body"' };
const newer = (data: MarketCard, scope = "guest") => ({ scope, data, savedAt: 200, checkedAt: 200, requestedAt: 190 });

test("a newer list card replaces an old detail price without losing its saved discussion", () => {
  const data = { card: card(1, "150"), comments: [{ id: 8, text: "saved comment" }], contributions: [{ id: 9 }] };
  const result = reconcileSavedMarketCards({ ...times, data }, [newer(card(2, "275"))]);
  assert.equal(result.data.card.data.defaultSalePrice, "275");
  assert.equal(result.data.card.revision, 2);
  assert.equal(result.data.comments, data.comments);
  assert.equal(result.data.contributions, data.contributions);
  assert.equal(data.card.data.defaultSalePrice, "150", "the original HTTP body stays intact");
  assert.equal(result.partial, true);
  assert.equal(result.etag, null, "a mixed body must not reuse the original ETag");
  assert.equal(result.savedAt, 100, "the old discussion time is not presented as freshly downloaded");
});

test("same-revision counter changes also update list copies and their derived name", () => {
  const data = { items: [{ ...card(1, "150"), englishName: "Saved medicine" }], total: 30, page: 2, pageSize: 18 };
  const latest = card(1, "275", 7); latest.data.englishName = "Updated medicine";
  const result = reconcileSavedMarketCards({ ...times, data }, [newer(latest)]);
  assert.equal(result.data.items[0].likes, 7);
  assert.equal(result.data.items[0].englishName, "Updated medicine");
  assert.equal(result.data.items[0].data.defaultSalePrice, "275");
  assert.equal(result.data.total, 30);
  assert.equal(result.data.page, 2);
  assert.equal(result.partial, true);
  assert.equal(result.etag, null);
});

test("different authorities and older card copies cannot alter an authorized response", () => {
  const data = { card: card(2, "275"), comments: [], contributions: [] };
  for (const candidate of [newer(card(3, "owner-private"), "user:71:owner"),
    newer(card(1, "old-revision")), { ...newer(card(2, "old-request")), requestedAt: 80 }]) {
    const result = reconcileSavedMarketCards({ ...times, data }, [candidate]);
    assert.equal(result.data, data);
    assert.equal(result.data.card.data.defaultSalePrice, "275");
    assert.equal(result.etag, times.etag);
    assert.equal(result.partial, false);
  }
});

test("an identical newer card preserves the complete snapshot and its conditional validator", () => {
  const data = { card: card(1, "150"), comments: [], contributions: [] };
  const result = reconcileSavedMarketCards({ ...times, data }, [newer(card(1, "150"))]);
  assert.equal(result.data, data);
  assert.equal(result.etag, times.etag);
  assert.equal(result.partial, false);
});

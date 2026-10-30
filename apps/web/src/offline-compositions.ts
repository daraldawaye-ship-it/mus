import { api } from "./api";
import { readCatalogProgress, rememberRead, saveCatalogProgress } from "./offline-storage";

export async function cacheItemCompositions(userId: number, companyId: number) {
  const saved = await readCatalogProgress(userId, companyId, "compositions");
  if (saved.complete) return;
  const page = saved.nextPage;
  const url = "/companies/" + companyId + "/item-compositions?page=" + page + "&pageSize=100&active=true";
  const data = await api<{ items: Record<string, unknown>[]; total: number }>(url);
  await rememberRead(url, data);
  for (const card of data.items) {
    if (typeof card.id === "number") {
      await rememberRead("/companies/" + companyId + "/item-compositions/" +
        card.id, { composition: card });
    }
  }
  const done = page * 100 >= data.total || data.items.length < 100;
  await saveCatalogProgress(userId, companyId, "compositions", page + 1, done);
}

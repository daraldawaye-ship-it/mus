import { api } from "./api";
import { readCatalogProgress, rememberRead, saveCatalogProgress } from "./offline-storage";

export async function cacheQuestionPages(userId: number, companyId: number) {
  for (const root of ["/questions", "/companies/" + companyId + "/questions"]) {
    let categories: { items: { category: string }[] };
    try {
      categories = await api(root + "/categories");
      await rememberRead(root + "/categories", categories);
    } catch { continue; }
    for (const { category } of categories.items) {
      const section = "question:" + root + ":" + category;
      const saved = await readCatalogProgress(userId, companyId, section);
      if (saved.complete) continue;
      const page = saved.nextPage;
      const url = root + "?" + new URLSearchParams({
        page: String(page), pageSize: "20", q: "", category, status: "active",
      });
      try {
        const response = await api<{ items: unknown[]; total: number }>(url);
        await rememberRead(url, response);
        const complete = page * 20 >= response.total || response.items.length < 20;
        await saveCatalogProgress(userId, companyId, section, page + 1, complete);
      } catch { /* Retry this page later. */ }
    }
  }
}

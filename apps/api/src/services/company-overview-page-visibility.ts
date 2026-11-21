import type { Database } from "../db.ts";

export async function companyOverviewHiddenPageKeys(
  db: Database,
  companyId: number | null,
): Promise<ReadonlySet<string>> {
  if (companyId === null) return new Set();
  const { rows } = await db.query<{ page_key: string }>(
    "SELECT page_key FROM company_overview_hidden_pages WHERE company_id=$1",
    [companyId],
  );
  return new Set(rows.map(({ page_key }) => page_key));
}

export async function setCompanyOverviewPageVisibility(
  db: Database,
  companyId: number,
  pageKey: string,
  showOnCompanyOverview: boolean,
): Promise<boolean> {
  if (showOnCompanyOverview) {
    const result = await db.query(
      "DELETE FROM company_overview_hidden_pages WHERE company_id=$1 AND page_key=$2",
      [companyId, pageKey],
    );
    return Boolean(result.rowCount);
  }

  // The route must check pageByKey first. As with grants, some code-owned
  // definitions may not yet have their matching registry row on older databases.
  await db.query("INSERT INTO page_registry(key) VALUES($1) ON CONFLICT(key) DO NOTHING", [pageKey]);
  const result = await db.query(
    "INSERT INTO company_overview_hidden_pages(company_id,page_key) VALUES($1,$2) ON CONFLICT(company_id,page_key) DO NOTHING",
    [companyId, pageKey],
  );
  return Boolean(result.rowCount);
}

import type { Pool } from "pg";

/** Only missing dates are built; already prepared counts are kept current by triggers. */
export async function prepareItemSaleRankings(pool: Pool): Promise<void> {
  await pool.query("SELECT prepare_item_sale_rankings()");
}

/** Prepares tomorrow independently of notifications and waits on graceful shutdown. */
export function startItemSaleRankings(pool: Pool): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = prepareItemSaleRankings(pool)
      .catch((error: unknown) => {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code) : "worker_error";
        console.error("Item search statistics worker failed",
          /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "worker_error");
      })
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

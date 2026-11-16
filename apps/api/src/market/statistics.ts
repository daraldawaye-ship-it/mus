import type { Pool } from "pg";

/** Each completed row carries its own next weekly deadline across restarts. */
export function startMarketStatisticsChecks(pool: Pool) {
  let stopped = false;
  let timer: NodeJS.Timeout;
  async function check() {
    let delay = 60_000;
    try {
      const {rows} = await pool.query("SELECT market_check_statistics(64) AS checked");
      if (rows[0].checked > 0) delay = 100;
    } catch (error) {
      console.error("MARKET_STATISTICS_CHECK_FAILED", (error as {code?: string}).code ?? "internal");
      delay = 5_000;
    }
    if (!stopped) timer = setTimeout(check, delay);
  }
  timer = setTimeout(check, 100);
  return () => { stopped = true; clearTimeout(timer); };
}

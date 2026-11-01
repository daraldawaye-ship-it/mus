import type { Pool } from "pg";
import { transaction } from "../db.ts";

const tables = ["medicine_market_cards", "medicine_market_contributions", "medicine_market_policies", "medicine_market_points", "medicine_market_comments", "medicine_market_reactions"] as const;
/** One-shot copy to an EMPTY initialized destination. Caller must freeze all market traffic before cutover. */
export async function transferMarket(source: Pool, destination: Pool) {
  return transaction(source, async src => {
    await src.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await src.query("SET LOCAL lock_timeout='5s'");
    await src.query("SET LOCAL statement_timeout='60s'");
    // These six module tables only. Never locks a company, item, balance or invoice table.
    await src.query(`LOCK TABLE ${tables.join(",")} IN SHARE MODE`);
    return transaction(destination, async dst => {
      await dst.query("SET LOCAL statement_timeout='60s'");
      await dst.query("SELECT pg_advisory_xact_lock(hashtext('market-transfer'))");
      for (const table of ["users", "audit_events", ...tables]) {
        if ((await dst.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount) throw new Error("Destination must be empty; refusing overwrite or duplicate import");
      }
      const receipts: { table: string; rows: number }[] = [];
      const copy = async (table: string, select: string, order: string[]) => {
        const columns = (await dst.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [table])).rows.map(r => r.attname as string);
        const quoted = columns.map(c => `"${c}"`).join(",");
        let offset = 0;
        for (;;) {
          // row_to_json keeps full PostgreSQL timestamp/decimal precision, without JS Date/Number conversion.
          const batch = (await src.query(`SELECT row_to_json(t)::text payload FROM (${select} ORDER BY ${order.join(",")} LIMIT 250 OFFSET $1) t`, [offset])).rows.map(r => r.payload as string);
          if (!batch.length) break;
          const payload = "[" + batch.join(",") + "]";
          await dst.query(`INSERT INTO ${table}(${quoted}) OVERRIDING SYSTEM VALUE SELECT ${quoted} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [payload]);
          const expected = await src.query("SELECT md5($1::jsonb::text) digest", [payload]);
          const actual = await dst.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text) digest FROM (SELECT ${quoted} FROM ${table} ORDER BY ${order.join(",")} LIMIT 250 OFFSET $1) t`, [offset]);
          if (expected.rows[0].digest !== actual.rows[0].digest) throw new Error(`Copy verification failed for ${table}`);
          offset += batch.length;
        }
        if (columns.includes("id") && table !== "users") {
          await dst.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE(max(id),1),count(*)>0) FROM ${table}`, [table]);
        }
        receipts.push({ table, rows: offset });
      };
      await copy("users", `SELECT id,display_name FROM users WHERE id IN (
        SELECT created_by FROM medicine_market_cards UNION SELECT author_id FROM medicine_market_contributions
        UNION SELECT reviewer_id FROM medicine_market_contributions UNION SELECT user_id FROM medicine_market_points
        UNION SELECT author_id FROM medicine_market_comments UNION SELECT reviewer_id FROM medicine_market_comments
        UNION SELECT user_id FROM medicine_market_reactions UNION SELECT actor_id FROM audit_events WHERE target_type='medicine-market'
      )`, ["id"]);
      for (const table of tables) await copy(table, `SELECT * FROM ${table}`, table === "medicine_market_policies" ? ["kind", "field_key"] : table === "medicine_market_reactions" ? ["card_id", "user_id"] : ["id"]);
      await copy("audit_events", "SELECT id,actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value,created_at FROM audit_events WHERE target_type='medicine-market'", ["id"]);
      return receipts;
    });
  });
}

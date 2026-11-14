import type { Pool } from "pg";
import { marketTypes, type MarketKind } from "../../../../packages/contracts/src/medicine-market.ts";

const clean = (value: string) => value.normalize("NFKC").toLowerCase()
  .replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function writtenFormPattern(pool: Pool) {
  const { rows } = await pool.query("SELECT name, data->>'englishName' AS english FROM medicine_market_cards WHERE kind='dosage-form' AND status='published' AND NOT archived");
  const aliases = ["tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syrup", "cream", "ointment", "gel", "drops", "sachets", "ampoules", "vials", "injection", "suppositories", "اقراص", "قرص", "كبسول", "كبسولات", "شراب", "مرهم", "كريم", "قطرة", "امبول", "فيال"];
  const names = [...new Set([...aliases, ...rows.flatMap(row => [row.name, row.english])].filter(Boolean).map(clean).filter(Boolean))];
  return new RegExp("(?:^| )(?:" + names.join("|") + ")(?: |$)", "u");
}

export async function marketCardCoverage(pool: Pool, kind: MarketKind) {
  const fields = marketTypes.find(type => type.key === kind)!.fields;
  const joins: string[] = [];
  // Field and kind identifiers below come exclusively from the static market contract.
  const checks = fields.map((field, index) => {
    const value = "c.data->'" + field.key + "'";
    let present = value + " IS NOT NULL AND " + value + " NOT IN ('null'::jsonb,'[]'::jsonb,'{}'::jsonb) AND btrim(c.data->>'" + field.key + "') <> ''";
    if (field.key === "name") present = "btrim(c.name) <> ''";
    if (field.key === "image") present = "coalesce(nullif(btrim(c.data->>'image'),''),nullif(btrim(c.data->>'imageUrl'),'')) IS NOT NULL";
    if (field.type === "prescription-lines") present = "jsonb_path_exists(" + value + ", '$[*] ? (@.type() == \"number\" || @.id.type() == \"number\")')";
    if (field.type === "relation") {
      const target = "r" + index;
      joins.push("LEFT JOIN medicine_market_cards " + target + " ON " + target + ".kind='" + field.relationKind + "' AND " + target + ".id::text=c.data->>'" + field.key + "'");
      present = target + ".id IS NOT NULL";
    }
    return "count(*) FILTER (WHERE " + present + ")::int AS f" + index;
  });
  const active = "c.kind=$1 AND c.status='published' AND NOT c.archived";
  const formIndex = fields.findIndex(field => field.key === "dosageFormId");
  // Keep form-name recognition and the totals on the same snapshot of source cards.
  if (formIndex >= 0) checks.push("array_agg(concat_ws(' ', c.name, c.data->>'englishName')) FILTER (WHERE r" + formIndex + ".id IS NULL) AS unlinked_names");
  const pattern = formIndex >= 0 ? await writtenFormPattern(pool) : null;
  const { rows: [row] } = await pool.query("SELECT count(*)::int AS total, " + checks.join(", ") + " FROM medicine_market_cards c " + joins.join(" ") + " WHERE " + active, [kind]);
  const counts = fields.map((field, index) => ({ key: field.key, label: field.label, filled: Number(row["f" + index]) }));
  if (pattern) {
    const written = (row.unlinked_names ?? []).filter((name: string) => pattern.test(clean(name))).length;
    counts.splice(formIndex + 1, 0, {key: "formCoverage", label: "الشكل الصيدلاني (مرتبط أو مذكور في الاسم)", filled: counts[formIndex]!.filled + written});
  }
  return { total: Number(row.total), fields: counts };
}

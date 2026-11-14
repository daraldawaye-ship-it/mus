import type { PoolClient } from "pg";
import { HttpError } from "../errors.ts";

/** Arguments are server-owned SQL expressions, never request values. */
export function thirdPartyGoodsSql(kind: "item" | "account", company: string, record: string): string {
  const key = kind === "item" ? "items.third-party-goods" : "accounts.third-party-goods-account";
  const column = kind === "item" ? "item_id" : "account_id";
  return `EXISTS (SELECT 1 FROM option_definitions tpd
    LEFT JOIN option_values tpv ON tpv.company_id=tpd.company_id
      AND tpv.definition_id=tpd.id AND tpv.record_kind='${kind}' AND tpv.${column}=${record}
    WHERE tpd.company_id=${company} AND tpd.record_kind='${kind}'
      AND tpd.key='${key}' AND tpd.active
      AND COALESCE(tpv.value,tpd.default_value)='true'::jsonb)`;
}

export async function assertThirdPartyGoodsAccount(
  client: PoolClient, companyId: number, accountId: number, itemIds: number[],
): Promise<void> {
  const result = await client.query(`SELECT
    EXISTS (SELECT 1 FROM items tpi WHERE tpi.company_id=$1 AND tpi.id=ANY($3::integer[])
      AND ${thirdPartyGoodsSql("item", "tpi.company_id", "tpi.id")}) AS has_goods,
    EXISTS (SELECT 1 FROM items tpi WHERE tpi.company_id=$1 AND tpi.id=ANY($3::integer[])
      AND NOT ${thirdPartyGoodsSql("item", "tpi.company_id", "tpi.id")}) AS has_regular_goods,
    ${thirdPartyGoodsSql("account", "$1", "$2")} AS valid_account`,
  [companyId, accountId, itemIds]);
  if (result.rows[0].has_regular_goods && result.rows[0].valid_account)
    throw new HttpError(409, "third_party_goods_only",
      "حساب أصناف الغير يقبل أصناف الغير فقط؛ احذف الأصناف العادية أو اختر حسابًا غير مصنف لأصناف الغير.");
  if (result.rows[0].has_goods && !result.rows[0].valid_account)
    throw new HttpError(409, "third_party_goods_account_required",
      "الفاتورة تحتوي أصناف الغير؛ اختر حسابًا مفعّلًا فيه خيار «حساب أصناف الغير» قبل الحفظ.");
}

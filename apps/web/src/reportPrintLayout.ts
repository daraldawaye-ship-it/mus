import { pageByKey } from "../../../packages/contracts/src/pages.ts";

/** Some reports (including a pledged account ledger) already render their
 * own company masthead and a print action. Do not prepend a second masthead. */
export function reportPrintLayout(
  pageKey: string | undefined | null,
): "none" | "generic" | "own" {
  if (!pageKey || pageByKey(pageKey)?.type !== "report") return "none";
  return pageKey === "company.account-ledger" ? "own" : "generic";
}

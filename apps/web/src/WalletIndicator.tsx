import { Coins } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  CompanyContext,
  WalletSummary,
} from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { usePageDirectory } from "./page-directory";

export function WalletIndicator({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const companyId = context.company.id;
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find((entry) => entry.key === "company.wallet");
  const allowed =
    !!user && !!context.employee && !!page?.enabled && !!page.actionAccess.view;
  const query = useQuery({
    queryKey: ["wallet-summary", user?.id, companyId, context.employee?.id],
    queryFn: ({ signal }) =>
      api<{ wallet: WalletSummary | null }>(
        `/companies/${companyId}/wallet/summary`,
        { signal },
      ),
    enabled: allowed,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  if (!allowed) return null;
  const wallet = query.data?.wallet;
  const label = query.isError
    ? "محفظتي، تعذر تحديث الرصيد"
    : wallet
      ? `محفظتي، ${wallet.points} نقطة`
      : "محفظتي، جارٍ تحميل الرصيد";
  return (
    <Link
      className="button button-ghost wallet-indicator"
      to={`/companies/${companyId}/wallet`}
      aria-label={label}
      title={label}
    >
      <Coins size={17} aria-hidden="true" />
      <span>
        {query.isError
          ? "!"
          : wallet
            ? BigInt(wallet.points).toLocaleString("ar-YE")
            : "…"}
      </span>
      <span className="desktop-only">نقطة</span>
    </Link>
  );
}

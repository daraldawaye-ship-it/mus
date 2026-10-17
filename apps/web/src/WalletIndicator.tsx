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
  const control = useQuery({
    queryKey: ["control", user?.id, companyId, context.employee?.id],
    queryFn: ({ signal }) =>
      api<{ options: { key: string; value: boolean | number }[] }>(
        `/companies/${companyId}/control?employeeId=${context.employee?.id}`,
        { signal },
      ),
    enabled: !!user && !!context.employee,
  });
  const showPoints = control.data?.options.find(
    (option) => option.key === "show_header_points",
  )?.value !== false;
  const allowed =
    !!user && !!context.employee && !!page?.enabled &&
    !!page.actionAccess.view && showPoints;
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
      {/* The coin glyph and amount identify the unified YER balance. */}
    </Link>
  );
}

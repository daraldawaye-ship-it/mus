import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";

export interface CompanyLetterhead {
  mediaId: string | null;
  imageUrl: string | null;
  updatedAt: string | null;
}

/** Shared and company-scoped; independent of the invoice, voucher or report. */
export function useCompanyLetterhead(companyId: number) {
  const { user } = useSession();
  return useQuery({
    queryKey: ["company-letterhead", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<CompanyLetterhead>(`/companies/${companyId}/letterhead`, { signal }),
    enabled: !!user,
    staleTime: 60_000,
  });
}

export function CompanyPrintHeader({
  context,
}: {
  context: CompanyContext;
}) {
  const letterhead = useCompanyLetterhead(context.company.id);
  const imageUrl = letterhead.data?.imageUrl;
  return (
    <div className="company-print-letterhead">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`ترويسة ${context.company.name}`}
          className="company-print-letterhead-image"
        />
      ) : (
        <div className="company-print-letterhead-fallback">
          <strong>{context.company.name}</strong>
          {context.company.phone && <span dir="ltr">{context.company.phone}</span>}
          {context.company.address && <span>{context.company.address}</span>}
        </div>
      )}
    </div>
  );
}

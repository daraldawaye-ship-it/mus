import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = imageUrl && failedUrl !== imageUrl;
  return (
    <div className="company-print-letterhead">
      {showImage ? (
        <img
          src={imageUrl}
          alt={`ترويسة ${context.company.name}`}
          className="company-print-letterhead-image"
          loading="eager"
          decoding="sync"
          onError={() => setFailedUrl(imageUrl)}
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

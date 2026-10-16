import { useQuery } from "@tanstack/react-query";
import { api, useSession } from "./api";
type ControlResponse = { options: { key: string; value: boolean | number }[] };
/** UI hint only. API handlers remain authoritative. */
export function useControls(companyId: number, employeeId: number | null = null) {
  const { user } = useSession();
  const query = useQuery({
    queryKey: ["control", user?.id, companyId, employeeId],
    queryFn: ({ signal }) => api<ControlResponse>(
      `/companies/${companyId}/control${employeeId ? `?employeeId=${employeeId}` : ""}`,
      { signal },
    ),
    enabled: !!user && companyId > 0,
  });
  const value = (key: string): boolean | number | undefined =>
    query.data?.options.find(row => row.key === key)?.value;
  return { ...query, value };
}
export function isMobileDevice(): boolean {
  return typeof navigator !== "undefined" &&
    /android|iphone|ipad|ipod|mobile|windows phone/i.test(navigator.userAgent);
}

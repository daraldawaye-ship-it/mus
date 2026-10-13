import { Bell } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { NotificationDirectory } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { usePageDirectory } from "./page-directory";

export function NotificationBell({ companyId }: { companyId?: number }) {
  const { user } = useSession();
  const scope = companyId ? `company:${companyId}` : "public";
  const base = companyId ? `/companies/${companyId}` : "";
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(
    (entry) =>
      entry.key === `${companyId ? "company" : "public"}.notifications`,
  );
  const allowed = !!user && (!page || (page.enabled && page.actionAccess.view));
  const query = useQuery({
    queryKey: ["notifications", user?.id, scope, "bell"],
    queryFn: ({ signal }) =>
      api<NotificationDirectory>(
        `${base}/notifications?state=active&pageSize=1`,
        { signal },
      ),
    enabled: allowed,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  if (!allowed) return null;
  const unread = query.data?.unread ?? 0;
  return (
    <Link
      className="button button-ghost notification-bell"
      to={`${base}/notifications`}
      aria-label={
        query.isError
          ? "التنبيهات، تعذر تحديث العدد"
          : `التنبيهات، ${unread} غير مقروء`
      }
      title={
        query.isError ? "تعذر تحديث العدد؛ افتح التنبيهات" : "فتح التنبيهات"
      }
    >
      <Bell size={18} />
      {unread > 0 && (
        <span className="notification-count" aria-hidden="true">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
      {query.isError && (
        <span
          className="notification-count notification-count-error"
          aria-hidden="true"
        >
          !
        </span>
      )}
    </Link>
  );
}

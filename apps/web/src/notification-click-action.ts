export type NotificationClickTarget = {
  id: number;
  revision: number;
  companyId: number | null;
  completedAt: string | null;
  completeOnClick?: boolean;
};

export function notificationClickAction(
  record: NotificationClickTarget,
  event: { defaultPrevented: boolean; button: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
) {
  if (!record.completeOnClick || record.completedAt || event.defaultPrevented || event.button !== 0 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const base = record.companyId === null ? "" : `/companies/${record.companyId}`;
  return {
    path: `${base}/notifications/${record.id}/action`,
    body: { action: "complete", revision: record.revision, onClick: true },
  } as const;
}

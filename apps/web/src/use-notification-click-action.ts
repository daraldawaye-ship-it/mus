import { useRef, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, useSession } from "./api";
import { notificationClickAction, type NotificationClickTarget } from "./notification-click-action";

export const notificationClickErrorEvent = "alraesy:notification-click-error";

export function useNotificationClickAction() {
  const { user } = useSession();
  const client = useQueryClient();
  const pending = useRef(new Set<string>());
  return (record: NotificationClickTarget, event: MouseEvent<HTMLElement>) => {
    if (!user) return;
    const request = notificationClickAction(record, event);
    if (!request || pending.current.has(request.path)) return;
    pending.current.add(request.path);
    // The click may also navigate, so the authorized action must not be
    // canceled on unmount. The server checks the recipient, setting and revision.
    void api(request.path, { method: "POST", body: request.body }).catch(() => {
      window.dispatchEvent(new CustomEvent(notificationClickErrorEvent, { detail: user.id }));
    }).finally(async () => {
      pending.current.delete(request.path);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["notifications", user.id] }),
        client.invalidateQueries({
          queryKey: ["list", user.id],
          predicate: query => typeof query.queryKey[2] === "string" &&
            query.queryKey[2].endsWith(":notifications"),
        }),
      ]);
    }).catch(() => {});
  };
}

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { ChatScope } from "../../../../packages/contracts/src/chat";

/** The current actor may use their uploaded asset through the same scoped route. */
export function ownChatAvatarUrl(user: { id: number; image: string }, scope: ChatScope, companyId?: number) {
  const asset = /^\/api\/media\/([a-f0-9-]{36})\/full$/.exec(user.image)?.[1];
  if (!asset) return null;
  const params = new URLSearchParams({ scope, v: asset });
  if (scope === "company" && companyId) params.set("companyId", String(companyId));
  return `/api/chat/avatars/${user.id}?${params}`;
}

/** Photos are served by the backend's current actor/scope authorization route. */
function avatarSource(avatarUrl?: string | null) {
  if (!avatarUrl?.startsWith("/api/chat/avatars/")) return "";
  try {
    const url = new URL(avatarUrl, window.location.origin);
    return url.origin === window.location.origin && /^\/api\/chat\/avatars\/[1-9]\d*$/.test(url.pathname) && !url.hash
      ? `${url.pathname}${url.search}` : "";
  } catch { return ""; }
}

export function ChatAvatar({ name, avatarUrl, size = "normal", className = "" }: {
  name: string;
  avatarUrl?: string | null;
  size?: "normal" | "small" | "tiny";
  className?: string;
}) {
  const source = avatarSource(avatarUrl);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [source]);
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => Array.from(part)[0] ?? "").join("");
  const displayImage = !!source && !imageFailed;
  return <span
    className={`chat-avatar ${size === "small" ? "chat-avatar-small" : size === "tiny" ? "chat-avatar-tiny" : ""} ${className}`}
    aria-hidden="true"
    data-chat-avatar={displayImage ? "image" : "fallback"}
  >
    {displayImage ? <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : initials || <UserRound size={size === "tiny" ? 13 : 19} />}
  </span>;
}

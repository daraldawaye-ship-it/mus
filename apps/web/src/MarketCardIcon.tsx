import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { MarketCard } from "../../../packages/contracts/src/medicine-market";
import "./MarketCardIcon.css";

type ImageCard = Pick<MarketCard, "id" | "kind" | "revision" | "data">;
export function hasMarketCardImage(card: ImageCard): boolean {
  const image = card.data.image ?? card.data.imageUrl;
  return card.kind !== "composition" && typeof image === "string" &&
    (/^https:\/\//i.test(image) || /^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(image));
}
export function marketCardImageVariant(card: ImageCard, variant: "icon" | "preview") {
  return `/api/medicine-market/cards/${card.id}/image-variants/${variant}?v=${card.revision}`;
}
/** Never fall back to the large original in a search row or catalog list. */
export function MarketCardIcon({ card }: { card: ImageCard }) {
  const src = marketCardImageVariant(card, "icon");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!hasMarketCardImage(card)) return null;
  return <span className="market-card-photo-icon" aria-hidden="true">
    {failed ? <ImageIcon size={20} /> : <img key={src} src={src} alt="" width={38} height={38}
      loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </span>;
}

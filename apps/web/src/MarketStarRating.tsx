import { useId, useState } from "react";
import { Star, X } from "lucide-react";

const scores = [1, 2, 3, 4, 5];

export function MarketStarRating({ value, disabled, onChange }: {
  value: number | null;
  disabled: boolean;
  onChange: (rating: number | null) => void;
}) {
  const group = useId();
  const [preview, setPreview] = useState<number>();
  const highlighted = (disabled ? undefined : preview) ?? value ?? 0;

  return <fieldset className="market-star-rating" disabled={disabled}
    onPointerLeave={() => setPreview(undefined)}>
    <legend>تقييمك</legend>
    <div className="market-star-rating-row">
      <div className="market-star-rating-stars" dir="ltr">
        {scores.map(score => <label key={score} className="market-star-rating-choice"
          onPointerEnter={event => {
            if (event.pointerType === "mouse") setPreview(score);
          }}>
          <input type="radio" name={group} value={score} checked={value === score}
            aria-label={`${score} من 5`}
            onChange={() => { setPreview(undefined); onChange(score); }} />
          <span className={score <= highlighted ? "is-filled" : ""} aria-hidden="true">
            <Star size={12} strokeWidth={2} fill={score <= highlighted ? "currentColor" : "none"} />
            <small>{score}</small>
          </span>
        </label>)}
      </div>
      {value !== null && <button type="button" className="market-star-rating-clear"
        aria-label="إزالة تقييمي" title="إزالة تقييمي"
        onPointerEnter={() => setPreview(undefined)}
        onClick={() => { setPreview(undefined); onChange(null); }}>
        <X size={12} aria-hidden="true" />
      </button>}
    </div>
  </fieldset>;
}

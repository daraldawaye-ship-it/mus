/**
 * Native <select> popups are sized by the longest <option> in some browsers.
 * Bound visible option labels so long account names cannot push the popup
 * beyond the viewport; the complete names remain available in title/search.
 */
export function lookupOptionLabel(label: string, viewportWidth: number): string {
  const limit = viewportWidth < 380 ? 18 : viewportWidth < 760 ? 26 : 40;
  const characters = Array.from(label);
  return characters.length <= limit
    ? label
    : characters.slice(0, limit - 1).join("") + "…";
}

type Entry = { index: number; key: string };
type HistoryState = Entry & { furthest: number };
type Navigation = "PUSH" | "REPLACE" | "POP";

/** React Router indexes this tab's in-app history from zero. Never use
 * history.length: it also includes pages outside the app. */
export function siteHistory(previous: HistoryState | null, current: Entry, navigation: Navigation): HistoryState {
  if (previous?.index === current.index && previous.key === current.key) return previous;
  const furthest = navigation === "PUSH" ? current.index : Math.max(previous?.furthest ?? 0, current.index);
  return {...current,furthest};
}

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

const hitSize = 44;
export const workPanelThumbOffset = (scrollTop: number, scrollRange: number, travel: number) =>
  scrollRange > 0 ? Math.max(0, Math.min(1, scrollTop / scrollRange)) * Math.max(0, travel) : 0;
export const workPanelThumbScroll = (delta: number, start: number, scrollRange: number, travel: number) =>
  Math.max(0, Math.min(scrollRange, start + (travel > 0 ? delta / travel * scrollRange : 0)));

export function WorkPanelScrollThumb({ viewport, content, controls }: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  controls: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number; top: number; range: number; travel: number } | null>(null);
  const [position, setPosition] = useState({ top: 0, range: 0, travel: 0 });

  useEffect(() => {
    const pane = viewport.current, inner = content.current, rail = track.current;
    if (!pane || !inner || !rail) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = { top: Math.round(pane.scrollTop),
        range: Math.max(0, pane.scrollHeight - pane.clientHeight),
        travel: Math.max(0, rail.clientHeight - hitSize) };
      setPosition(previous => previous.top === next.top && previous.range === next.range &&
        previous.travel === next.travel ? previous : next);
    };
    const changed = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(changed);
    observer?.observe(pane);
    observer?.observe(inner);
    observer?.observe(rail);
    // Native scroll, geometry changes and private Dock content resizing all use the same viewport.
    pane.addEventListener("scroll", changed, { passive: true });
    window.addEventListener("resize", changed);
    measure();
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      pane.removeEventListener("scroll", changed);
      window.removeEventListener("resize", changed);
    };
  }, [viewport, content]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    const pane = viewport.current, rail = track.current;
    if (event.button !== 0 || !event.isPrimary || drag.current || !pane || !rail) return;
    const range = Math.max(0, pane.scrollHeight - pane.clientHeight), travel = rail.clientHeight - hitSize;
    if (!range || travel <= 0) return;
    drag.current = { id: event.pointerId, y: event.clientY, top: pane.scrollTop, range, travel };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const pane = viewport.current, start = drag.current;
    if (!pane || !start || start.id !== event.pointerId) return;
    pane.scrollTop = workPanelThumbScroll(event.clientY - start.y, start.top, start.range, start.travel);
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const pane = viewport.current;
    if (!pane) return;
    const increments: Record<string, number> = { ArrowUp: -32, ArrowDown: 32, PageUp: -pane.clientHeight, PageDown: pane.clientHeight };
    if (event.key === "Home") pane.scrollTop = 0;
    else if (event.key === "End") pane.scrollTop = pane.scrollHeight;
    else if (Object.hasOwn(increments, event.key)) pane.scrollTop += increments[event.key];
    else return;
    event.preventDefault();
  }

  const reachable = position.range > 0 && position.travel > 0;
  const top = Math.max(0, Math.min(position.range, position.top));
  return <div ref={track} className="resizable-work-panel-scroll-track" data-scrollable={reachable || undefined}>
    {reachable && <div
      className="resizable-work-panel-scroll-thumb" role="scrollbar" tabIndex={0}
      aria-label="تمرير محتوى لوح العمل" aria-controls={controls} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={position.range} aria-valuenow={top}
      aria-valuetext={`${Math.round(top / position.range * 100)}٪`}
      title="اسحب لتمرير محتوى لوح العمل"
      style={{ transform: `translateY(${workPanelThumbOffset(top, position.range, position.travel)}px)` }}
      onPointerDown={begin} onPointerMove={move} onPointerUp={end}
      onPointerCancel={end} onLostPointerCapture={end} onKeyDown={keys}
    />}
  </div>;
}

import { useEffect, useRef, useState } from "react";

export default function DesignLibraryScrollableCell({ value, hint = true }: { value: string; hint?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; active: boolean } | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      const distance = node.scrollWidth - node.clientWidth;
      setOverflow(distance > 1);
      setAtEnd(Math.abs(node.scrollLeft) >= distance - 1);
    };
    const wheel = (event: WheelEvent) => {
      // Preserve normal vertical and horizontal scrolling. Some browsers
      // expose Shift + vertical wheel as deltaY instead of native deltaX.
      if (!event.shiftKey || event.ctrlKey || event.deltaX || !event.deltaY ||
          node.scrollWidth <= node.clientWidth) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      const next = Math.max(node.clientWidth - node.scrollWidth, Math.min(0, node.scrollLeft - event.deltaY * unit));
      if (next === node.scrollLeft) return;
      event.preventDefault();
      node.scrollLeft = next;
    };
    measure();
    // Observe both the viewport and text, including live column-width changes.
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    node.addEventListener("scroll", measure, { passive: true });
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      resize.disconnect();
      node.removeEventListener("scroll", measure);
      node.removeEventListener("wheel", wheel);
    };
  }, [value]);

  const finish = () => {
    drag.current = null;
    setGrabbing(false);
  };

  return <div className="design-cell-scroll-shell" data-hint={hint && overflow && !atEnd ? "true" : undefined}>
    <div ref={scroller} className="design-cell-scroll" dir="rtl" tabIndex={overflow ? 0 : undefined}
      data-overflow={overflow ? "true" : undefined} data-grabbing={grabbing ? "true" : undefined}
      onPointerDown={event => {
        if (!overflow || event.pointerType !== "mouse" || event.button !== 0 ||
            event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, active: false };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) return;
        if (!(event.buttons & 1)) { finish(); return; }
        const movedX = event.clientX - start.x;
        const movedY = event.clientY - start.y;
        if (!start.active) {
          if (Math.abs(movedY) >= 5 && Math.abs(movedY) > Math.abs(movedX)) { finish(); return; }
          if (Math.abs(movedX) < 5) return;
          start.active = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.ownerDocument.getSelection()?.collapseToStart();
          setGrabbing(true);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = start.left - movedX;
      }}
      onPointerLeave={() => { if (!drag.current?.active) finish(); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const node = event.currentTarget;
        if (event.key === "Home") node.scrollLeft = 0;
        else if (event.key === "End") node.scrollLeft = node.clientWidth - node.scrollWidth;
        else if (event.key === "ArrowLeft") node.scrollLeft -= 40;
        else if (event.key === "ArrowRight") node.scrollLeft += 40;
        else return;
        event.preventDefault();
      }}>
      <span>{value}</span>
    </div>
  </div>;
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import "./ScrollableTableCell.css";

type Drag = {
  pointer: number; x: number; y: number; left: number;
  active: boolean; node: HTMLDivElement;
};

function keepsOwnGesture(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    "input, select, textarea, label, [contenteditable]:not([contenteditable='false']), " +
    "[role='checkbox'], [role='switch'], [data-scroll-gesture='ignore']",
  );
}

/** A cell viewport: full text and controls remain available at any column width. */
export default function ScrollableTableCell({ children, hint = true, className = "" }: {
  children: ReactNode; hint?: boolean; className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  function finish() {
    const start = drag.current;
    drag.current = null;
    if (start?.active) suppressClick.current = true;
    if (start?.node.hasPointerCapture(start.pointer)) start.node.releasePointerCapture(start.pointer);
    setGrabbing(false);
  }

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      const distance = Math.max(0, node.scrollWidth - node.clientWidth);
      setOverflow(distance > 1);
      setAtEnd(Math.abs(node.scrollLeft) >= distance - 1);
    };
    const wheel = (event: WheelEvent) => {
      // Native vertical/touch scrolling and input gestures retain their behavior.
      if (keepsOwnGesture(event.target) || !event.shiftKey || event.ctrlKey ||
          event.deltaX || !event.deltaY || node.scrollWidth <= node.clientWidth) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      const next = Math.max(node.clientWidth - node.scrollWidth, Math.min(0, node.scrollLeft - event.deltaY * unit));
      if (next === node.scrollLeft) return;
      event.preventDefault();
      node.scrollLeft = next;
    };
    measure();
    // The inner max-content box also changes when an editor or value changes.
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    node.addEventListener("scroll", measure, { passive: true });
    node.addEventListener("wheel", wheel, { passive: false });
    const view = node.ownerDocument.defaultView;
    view?.addEventListener("blur", finish);
    return () => {
      resize.disconnect();
      node.removeEventListener("scroll", measure);
      node.removeEventListener("wheel", wheel);
      view?.removeEventListener("blur", finish);
      const start = drag.current;
      drag.current = null;
      if (start?.node.hasPointerCapture(start.pointer)) start.node.releasePointerCapture(start.pointer);
    };
  }, []);

  return <div className={`table-cell-scroll-shell${className ? ` ${className}` : ""}`}
    data-hint={hint && overflow && !atEnd ? "true" : undefined}>
    <div ref={scroller} className="table-cell-scroll" dir="rtl" tabIndex={overflow ? 0 : undefined}
      data-overflow={overflow ? "true" : undefined} data-grabbing={grabbing ? "true" : undefined}
      onPointerDownCapture={() => { suppressClick.current = false; }}
      onPointerDown={event => {
        if (!overflow || event.pointerType !== "mouse" || event.button !== 0 ||
            event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || keepsOwnGesture(event.target)) return;
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
          left: event.currentTarget.scrollLeft, active: false, node: event.currentTarget };
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
          event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();
          setGrabbing(true);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = Math.max(event.currentTarget.clientWidth - event.currentTarget.scrollWidth,
          Math.min(0, start.left - movedX));
      }}
      onDragStartCapture={event => { if (drag.current) event.preventDefault(); }}
      onClickCapture={event => {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerLeave={() => { if (!drag.current?.active) finish(); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => {
        // Child links, buttons and fields retain their own keyboard commands.
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const node = event.currentTarget;
        if (event.key === "Home") node.scrollLeft = 0;
        else if (event.key === "End") node.scrollLeft = node.clientWidth - node.scrollWidth;
        else if (event.key === "ArrowLeft") node.scrollLeft = Math.max(node.clientWidth - node.scrollWidth, node.scrollLeft - 40);
        else if (event.key === "ArrowRight") node.scrollLeft = Math.min(0, node.scrollLeft + 40);
        else return;
        event.preventDefault();
      }}>
      <div className="table-cell-scroll-content">{children}</div>
    </div>
  </div>;
}

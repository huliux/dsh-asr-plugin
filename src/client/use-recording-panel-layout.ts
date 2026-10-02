import { useEffect, useRef, useState } from "react";
import type { CSSProperties, Dispatch, KeyboardEvent, MutableRefObject, PointerEvent, SetStateAction } from "react";

interface Layout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly expanded: boolean;
}

type GestureKind = "move" | "resize";
interface Gesture {
  readonly kind: GestureKind;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly layout: Layout;
}

const MARGIN = 12;
const COMPACT_HEIGHT = 48;

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function fit(layout: Layout, compactWidth: number): Layout {
  const bounds = viewport();
  const availableWidth = Math.max(1, bounds.width - MARGIN * 2);
  const availableHeight = Math.max(1, bounds.height - MARGIN * 2);
  const width = Math.min(availableWidth, Math.max(300, layout.width));
  const height = Math.min(availableHeight, Math.max(260, layout.height));
  const visibleWidth = layout.expanded ? width : Math.min(compactWidth, availableWidth);
  const visibleHeight = layout.expanded ? height : Math.min(COMPACT_HEIGHT, availableHeight);
  return { ...layout, width, height,
    x: Math.max(MARGIN, Math.min(layout.x, bounds.width - visibleWidth - MARGIN)),
    y: Math.max(MARGIN, Math.min(layout.y, bounds.height - visibleHeight - MARGIN)) };
}

function initialLayout(compactWidth: number): Layout {
  const bounds = viewport();
  return fit({ expanded: false, width: 384, height: 480,
    x: bounds.width - compactWidth - MARGIN, y: bounds.height - COMPACT_HEIGHT - MARGIN }, compactWidth);
}

function update(layout: Layout, kind: GestureKind, x: number, y: number, compactWidth: number): Layout {
  return fit(kind === "move"
    ? { ...layout, x: layout.x + x, y: layout.y + y }
    : { ...layout, width: layout.width + x, height: layout.height + y }, compactWidth);
}

function keyboardDelta(event: KeyboardEvent<HTMLButtonElement>) {
  const step = event.shiftKey ? 40 : 10;
  switch (event.key) {
    case "ArrowLeft": return { x: -step, y: 0 };
    case "ArrowRight": return { x: step, y: 0 };
    case "ArrowUp": return { x: 0, y: -step };
    case "ArrowDown": return { x: 0, y: step };
    default: return null;
  }
}

function gestureHandlers(kind: GestureKind, layout: Layout, compactWidth: number,
  gesture: MutableRefObject<Gesture | null>, setLayout: Dispatch<SetStateAction<Layout>>) {
  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0 || gesture.current !== null) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { kind, pointerId: event.pointerId,
        x: event.clientX, y: event.clientY, layout };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const active = gesture.current;
      if (active?.pointerId !== event.pointerId) return;
      setLayout(update(active.layout, active.kind, event.clientX - active.x, event.clientY - active.y, compactWidth));
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      if (gesture.current?.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      gesture.current = null;
    },
    onLostPointerCapture() { gesture.current = null; },
    onPointerCancel() { gesture.current = null; },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      const delta = keyboardDelta(event);
      if (delta === null) return;
      event.preventDefault();
      setLayout(previous => update(previous, kind, delta.x, delta.y, compactWidth));
    },
  };
}

export function useRecordingPanelLayout(compactWidth: number) {
  const [layout, setLayout] = useState(() => initialLayout(compactWidth));
  const gesture = useRef<Gesture | null>(null);
  useEffect(() => {
    const resize = () => setLayout(previous => fit(previous, compactWidth));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [compactWidth]);
  const style: CSSProperties = { left: layout.x, top: layout.y,
    width: layout.expanded ? layout.width : Math.max(1, Math.min(compactWidth, viewport().width - MARGIN * 2)),
    height: layout.expanded ? layout.height : Math.max(1, Math.min(COMPACT_HEIGHT, viewport().height - MARGIN * 2)) };
  return { expanded: layout.expanded, style, move: gestureHandlers("move", layout, compactWidth, gesture, setLayout),
    resize: gestureHandlers("resize", layout, compactWidth, gesture, setLayout),
    toggle: () => setLayout(previous => fit({ ...previous, expanded: !previous.expanded }, compactWidth)),
    reset: () => setLayout(previous => fit({ ...previous,
      x: viewport().width - previous.width - MARGIN,
      y: viewport().height - previous.height - MARGIN }, compactWidth)) };
}

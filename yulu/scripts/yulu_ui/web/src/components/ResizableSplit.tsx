import type { ReactNode } from "react";
import { useCallback, useRef } from "react";
import { usePersistedSize } from "../hooks/usePersistedSize.js";
import "./ResizableSplit.css";

export interface ResizableSplitProps {
  storageKey: string;
  side: "left" | "right";
  min: number;
  max: number;
  defaultWidth: number;
  children: ReactNode;
}

/**
 * Wraps a fixed-width pane and renders a 4px draggable handle on the chosen
 * side. Mousedown captures global mousemove + mouseup; release commits the
 * new width to localStorage via usePersistedSize. Double-click resets to
 * defaultWidth. Width is clamped to [min, max] at all times.
 */
export function ResizableSplit({
  storageKey, side, min, max, defaultWidth, children,
}: ResizableSplitProps) {
  const [width, setWidth] = usePersistedSize(storageKey, defaultWidth);

  const widthRef = useRef(width);
  widthRef.current = width;
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const clamp = useCallback((value: number) => Math.max(min, Math.min(max, value)), [min, max]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    const sign = side === "right" ? 1 : -1;

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startXRef.current) * sign;
      setWidth(clamp(startWidthRef.current + delta));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [side, clamp, setWidth]);

  const onDoubleClick = useCallback(() => {
    setWidth(defaultWidth);
  }, [defaultWidth, setWidth]);

  return (
    <div className="rs-root" data-side={side}>
      <div className="rs-pane" style={{ width: `${width}px`, flex: `0 0 ${width}px` }}>
        {children}
      </div>
      <div
        className="rs-handle"
        data-side={side}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

"use client";

// The divider between the chat and the panel.
//
// "Resizable and dismissible. Drag the divider; collapse the panel and get the
// full-width chat back. The layout is the producer's, not ours." The maths is
// in surfaceStack.ts (`splitFromPointer`, `clampSplit`) and asserted there;
// this is the handle. Keyboard-reachable, because the mouse is not the only
// way in, and pointer-captured, so a fast drag that leaves the 4 px handle
// keeps tracking.

import { clampSplit } from "./surfaceStack";

export function Divider({
  split,
  onDrag,
  onCommit,
  onSet,
}: {
  /** the panel's share of the width, 0..1 */
  split: number;
  /** a pointer moved to this client x */
  onDrag: (clientX: number) => void;
  /** the drag ended: remember where it landed */
  onCommit: (value: number) => void;
  /** set and remember in one step (the arrow keys) */
  onSet: (value: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={28}
      aria-valuemax={74}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-rule focus-visible:bg-pad"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDrag(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(split);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSet(clampSplit(split + 0.04));
        else if (e.key === "ArrowRight") onSet(clampSplit(split - 0.04));
        else return;
        e.preventDefault();
      }}
    />
  );
}

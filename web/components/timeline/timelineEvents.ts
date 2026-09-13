// The timeline's view state, reachable by sentence.
//
// Snapping and the selection live in the session (both halves of the product
// need them), but zoom and scroll are the panel's own — a producer's view of
// the song, not a fact about it. "Zoom in" still has to move the same control
// the button moves, so it comes across this bus, the same way the shell's
// commands reach the transport (components/shell/sessionCommands.ts).

export type TimelineViewCommand = { kind: "zoom"; direction: "in" | "out" | "fit" } | { kind: "scroll-to"; sessionS: number };

const EVENT = "crateai:timeline-view";

export function emitTimelineView(command: TimelineViewCommand): void {
  window.dispatchEvent(new CustomEvent<TimelineViewCommand>(EVENT, { detail: command }));
}

export function onTimelineView(handler: (command: TimelineViewCommand) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && typeof (detail as TimelineViewCommand).kind === "string") handler(detail as TimelineViewCommand);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

// Carrying out a directive.
//
// A `directive` card is the model's half of the command line: steps already
// parsed on the server by `lib/session/commands.ts` (or `lib/pads/commands.ts`)
// into the very command the composer's own command line produces. All that is
// left here is to put each one on the bus it belongs to, in order, and wait for
// the control to say what it did.
//
// Three things this is careful about:
//
//   It runs exactly once, while the turn is streaming. A stored card renders
//   from `messages.tool_calls` as a receipt; re-applying it on render would
//   replay every edit in a conversation the moment it was reopened.
//
//   It waits for the control. The buses are one-way, so a step is followed by
//   its result line — the same line the mouse would have produced — and the
//   next step goes out after it. A run of steps therefore lands in the order
//   the model asked for, which matters for "solo the drums, then loop bars 9
//   to 16".
//
//   Silence is a failure, and is reported as one. The keyboard instrument only
//   listens while it is on screen, and a lane's chain only answers while the
//   processing provider is mounted, so a step can reach nothing at all. After
//   a short wait that is said plainly rather than left blank.

import { emitSessionCommand, onCommandResult } from "@/components/shell/sessionCommands";
import type { DirectiveCardStep } from "@/lib/chat/cards";
import { emitKeyboardCommand, onKeyboardResult, type KeyboardCommand } from "@/lib/pads/commands";
import type { SessionCommand } from "@/lib/session/commands";

/** How long a control has to answer before the step is reported as unheard. */
export const DIRECTIVE_TIMEOUT_MS = 700;

export interface DirectiveResult {
  said: string;
  /** the control's own line, or why nothing happened */
  text: string;
  ok: boolean;
  /** true when nothing on screen answered at all */
  unheard: boolean;
}

export interface DirectiveIo {
  emit: (step: DirectiveCardStep) => void;
  /** every command result, from either bus; returns the unsubscribe */
  listen: (handler: (result: { text: string; ok: boolean }) => void) => () => void;
  /** schedule, injected so a test never actually waits */
  schedule: (ms: number, run: () => void) => () => void;
}

export const NOTHING_HEARD = "nothing on screen answered that — the control it names is not open.";

/** The real buses. The keyboard's listener only exists while its panel is mounted. */
export const windowIo: DirectiveIo = {
  emit: (step) => {
    if (step.bus === "keyboard") emitKeyboardCommand(step.command as KeyboardCommand);
    else emitSessionCommand(step.command as SessionCommand);
  },
  listen: (handler) => {
    const offSession = onCommandResult(handler);
    const offKeyboard = onKeyboardResult(handler);
    return () => {
      offSession();
      offKeyboard();
    };
  },
  schedule: (ms, run) => {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
  },
};

function runStep(step: DirectiveCardStep, io: DirectiveIo, timeoutMs: number): Promise<DirectiveResult> {
  return new Promise((resolve) => {
    let settled = false;
    // Assigned after `finish` is defined, and cleared through these bindings,
    // so a fake bus that answers synchronously cannot trip over them.
    let off: (() => void) | null = null;
    let cancel: (() => void) | null = null;
    const finish = (result: DirectiveResult) => {
      if (settled) return;
      settled = true;
      off?.();
      cancel?.();
      resolve(result);
    };
    off = io.listen((result) => finish({ said: step.said, text: result.text, ok: result.ok, unheard: false }));
    cancel = io.schedule(timeoutMs, () => finish({ said: step.said, text: NOTHING_HEARD, ok: false, unheard: true }));
    if (settled) {
      off();
      cancel();
    } else {
      io.emit(step);
    }
  });
}

/**
 * Put every step on its bus, in order, and collect what each control said.
 * A step that is not heard does not stop the ones after it: the producer asked
 * for all of them, and the one that failed is named.
 */
export async function runDirective(
  steps: readonly DirectiveCardStep[],
  io: DirectiveIo = windowIo,
  timeoutMs: number = DIRECTIVE_TIMEOUT_MS,
): Promise<DirectiveResult[]> {
  const results: DirectiveResult[] = [];
  for (const step of steps) results.push(await runStep(step, io, timeoutMs));
  return results;
}

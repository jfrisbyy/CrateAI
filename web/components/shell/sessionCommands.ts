// The bus between the chat's command line and the controls it moves.
//
// The chat parses a sentence into a SessionCommand and puts it on this bus;
// the shell applies it to the same state the mouse touches and puts back one
// line saying what happened. That round trip is the rule from the direction
// document made mechanical: there is no path by which a sentence changes the
// session without the control showing it, because the sentence moves the
// control.

import type { SessionCommand } from "@/lib/session/commands";

const COMMAND_EVENT = "crateai:session-command";
const RESULT_EVENT = "crateai:session-command-result";

export interface CommandResult {
  /** one line, in the same words the control uses */
  text: string;
  /** false when the command could not be carried out (no such lane, no tempo yet) */
  ok: boolean;
}

export function emitSessionCommand(command: SessionCommand): void {
  window.dispatchEvent(new CustomEvent<SessionCommand>(COMMAND_EVENT, { detail: command }));
}

export function onSessionCommand(handler: (command: SessionCommand) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && typeof (detail as SessionCommand).kind === "string") handler(detail as SessionCommand);
  };
  window.addEventListener(COMMAND_EVENT, listener);
  return () => window.removeEventListener(COMMAND_EVENT, listener);
}

export function emitCommandResult(result: CommandResult): void {
  window.dispatchEvent(new CustomEvent<CommandResult>(RESULT_EVENT, { detail: result }));
}

export function onCommandResult(handler: (result: CommandResult) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && typeof (detail as CommandResult).text === "string") handler(detail as CommandResult);
  };
  window.addEventListener(RESULT_EVENT, listener);
  return () => window.removeEventListener(RESULT_EVENT, listener);
}

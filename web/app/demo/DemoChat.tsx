"use client";

// The prototype's chat pane.
//
// Same shape as components/chat/ChatPane: a transcript, the command echo above
// the composer, and the composer itself (the real one). Same rule, too — a
// sentence is parsed for a command first and only treated as conversation when
// it is unmistakably not one — and it is the same parser and the same bus, so
// what happens here is what happens in the app.
//
// What is different is the other half. There is no model, so the four written
// turns in script.ts stand in for it, and anything else gets one honest line
// saying so. Nothing here pretends to think.

import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/chat/Composer";
import { emitSessionCommand, onCommandResult } from "@/components/shell/sessionCommands";
import { btnQuiet, cx } from "@/components/ui";
import { parseSessionCommand } from "@/lib/session/commands";
import { COMMAND_EXAMPLES, DEMO_STEPS, fallbackReply, matchStep, type DemoStep } from "./script";

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** the line under an answer that says what to do on the panel */
  hint?: string;
}

export function DemoChat({ done, onStep }: { done: ReadonlySet<string>; onStep: (step: DemoStep) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [commandLog, setCommandLog] = useState<Array<{ id: number; said: string; text: string; ok: boolean }>>([]);
  const nextId = useRef(0);
  const said = useRef<string>("");
  const scroller = useRef<HTMLDivElement>(null);

  // The shell applies the command and says what it did; that line is the echo.
  useEffect(
    () =>
      onCommandResult((result) => {
        const from = said.current;
        said.current = "";
        setCommandLog((prev) => [...prev.slice(-3), { id: ++nextId.current, said: from, text: result.text, ok: result.ok }]);
      }),
    [],
  );

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const append = (role: Turn["role"], text: string, hint?: string) => {
    setTurns((prev) => [...prev, { id: ++nextId.current, role, text, ...(hint ? { hint } : {}) }]);
  };

  const runStep = (step: DemoStep) => {
    append("user", step.said);
    append("assistant", step.reply, step.hint);
    onStep(step);
  };

  const send = async (text: string) => {
    // The command line, first and narrowly, exactly as ChatPane does it.
    const command = parseSessionCommand(text);
    if (command) {
      said.current = text.trim();
      emitSessionCommand(command);
      return;
    }
    const step = matchStep(text);
    if (step) {
      append("user", text);
      append("assistant", step.reply, step.hint);
      onStep(step);
      return;
    }
    append("user", text);
    append("assistant", fallbackReply());
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 h-9 px-4 border-b border-rule flex items-center gap-2">
        <span className="text-sm truncate">The prototype</span>
        <span className="font-mono text-xs text-chalk-dim">{turns.filter((t) => t.role === "user").length}</span>
        <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={() => setTurns([])} disabled={turns.length === 0} title="Clear the transcript; the session keeps playing">
          Clear
        </button>
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto">
        {turns.length === 0 && <Opening />}
        <ol className="flex flex-col">
          {turns.map((turn) => (
            <li key={turn.id} className={cx("px-4 py-2 border-b border-rule", turn.role === "user" && "bg-slate")}>
              <div className="text-xs text-chalk-dim mb-0.5">{turn.role === "user" ? "You" : "Cratebox"}</div>
              <p className="text-sm whitespace-pre-wrap break-words">{turn.text}</p>
              {turn.hint && <p className="mt-1.5 text-xs text-chalk-dim border-l-2 border-pad pl-2">{turn.hint}</p>}
            </li>
          ))}
        </ol>
      </div>

      <div className="shrink-0 border-t border-rule px-4 py-2">
        <div className="text-xs text-chalk-dim mb-1.5">Walk it in this order</div>
        <ol className="flex flex-col gap-1">
          {DEMO_STEPS.map((step, i) => (
            <li key={step.id} className="flex items-baseline gap-2 min-w-0">
              <span className={cx("font-mono text-xs shrink-0 w-3", done.has(step.id) ? "text-pad" : "text-chalk-faint")}>{i + 1}</span>
              <button
                type="button"
                className={cx("text-left text-sm truncate hover:text-pad min-w-0", done.has(step.id) ? "text-chalk-dim" : "text-chalk")}
                onClick={() => runStep(step)}
                title={step.hint}
              >
                {step.said}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {commandLog.length > 0 && (
        <ul className="shrink-0 border-t border-rule px-4 py-1" aria-live="polite">
          {commandLog.map((entry) => (
            <li key={entry.id} className="text-xs text-chalk-dim flex items-baseline gap-2">
              <span aria-hidden className={entry.ok ? "text-pad" : "text-chalk-faint"}>
                ▸
              </span>
              <span className="truncate" title={entry.said}>
                {entry.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Composer disabled={false} onSend={send} />
    </div>
  );
}

/** What the page says before anything has been asked of it. */
function Opening() {
  return (
    <div className="px-4 py-3 text-sm text-chalk-dim max-w-[620px] flex flex-col gap-2">
      <p>
        This is Cratebox running, not a picture of it. The chat, the rack, the song and the transport are the product&rsquo;s own components on the
        product&rsquo;s own session engine; the only thing invented is the material.
      </p>
      <p>
        <span className="text-chalk">The audio is synthesised in your browser</span> — a Rhodes bed and five drum breaks, built out of oscillators and
        noise when the page loaded. It is not a separation result and it is not anyone&rsquo;s record. The measurements attached to it (tempo, key,
        confidences) are written to describe what was synthesised; everything computed <em>from</em> them — the ranking, the fit ratio, the reasons, the
        lineage on every region — is the real code.
      </p>
      <p>
        Start with the numbered list below. Then type at it: the transport and the arrangement answer sentences, and each one moves the control the
        mouse would have moved.
      </p>
      <p className="font-mono text-xs text-chalk-faint">{COMMAND_EXAMPLES.join(" · ")}</p>
    </div>
  );
}

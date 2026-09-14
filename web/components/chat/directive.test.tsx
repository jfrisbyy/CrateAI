// The client half of the command line: a directive from the model going onto
// the same bus a typed sentence goes onto.
//
// The buses are window events, so they are injected here rather than mocked:
// `runDirective` takes its emit, its listener and its clock, which is what
// makes the ordering and the timeout assertable in node.

import { describe, expect, it } from "vitest";
import type { DirectiveCardStep } from "@/lib/chat/cards";
import { NOTHING_HEARD, runDirective, type DirectiveIo } from "./directive";

const step = (said: string, line: string, bus: "session" | "keyboard" = "session"): DirectiveCardStep => ({
  said,
  bus,
  command: bus === "keyboard" ? { kind: "set-trigger", mode: "gate" } : { kind: "play" },
  line,
});

/** A bus that answers every step with a line, in order, like the shell does. */
function answeringIo(answer: (step: DirectiveCardStep) => { text: string; ok: boolean } | null) {
  const emitted: DirectiveCardStep[] = [];
  const handlers = new Set<(r: { text: string; ok: boolean }) => void>();
  const timers: Array<() => void> = [];
  const io: DirectiveIo = {
    emit: (s) => {
      emitted.push(s);
      const reply = answer(s);
      if (reply) queueMicrotask(() => {
        for (const h of [...handlers]) h(reply);
      });
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    schedule: (_ms, run) => {
      timers.push(run);
      return () => {
        const i = timers.indexOf(run);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  return { io, emitted, handlers, fire: () => [...timers].forEach((t) => t()) };
}

describe("runDirective", () => {
  it("puts every step on its bus in order and collects what each control said", async () => {
    const { io, emitted } = answeringIo((s) => ({ text: s.line, ok: true }));
    const results = await runDirective([step("solo the drums", "soloed drums"), step("play", "playing")], io, 1000);
    expect(emitted.map((s) => s.said)).toEqual(["solo the drums", "play"]);
    expect(results).toEqual([
      { said: "solo the drums", text: "soloed drums", ok: true, unheard: false },
      { said: "play", text: "playing", ok: true, unheard: false },
    ]);
  });

  it("waits for one step's answer before sending the next, so the order the model asked for holds", async () => {
    const order: string[] = [];
    const { io } = answeringIo((s) => {
      order.push(`emit:${s.said}`);
      return { text: s.line, ok: true };
    });
    await runDirective([step("a", "did a"), step("b", "did b")], io, 1000);
    expect(order).toEqual(["emit:a", "emit:b"]);
  });

  it("keeps a control's refusal as a refusal rather than reporting success", async () => {
    const { io } = answeringIo(() => ({ text: "nothing in the session is called horns.", ok: false }));
    const [result] = await runDirective([step("mute the horns", "muted horns")], io, 1000);
    expect(result).toMatchObject({ ok: false, unheard: false, text: "nothing in the session is called horns." });
  });

  it("says so when nothing on screen answers, instead of leaving the producer with silence", async () => {
    const { io, fire } = answeringIo(() => null);
    const pending = runDirective([step("gate", "gate: a key sounds while it is down.", "keyboard")], io, 1000);
    fire();
    const [result] = await pending;
    expect(result).toEqual({ said: "gate", text: NOTHING_HEARD, ok: false, unheard: true });
  });

  it("carries on after an unheard step rather than dropping the rest", async () => {
    let first = true;
    const { io, fire } = answeringIo((s) => {
      if (first) {
        first = false;
        return null;
      }
      return { text: s.line, ok: true };
    });
    const pending = runDirective([step("gate", "gate.", "keyboard"), step("play", "playing")], io, 1000);
    // the first step's timer fires; the second answers on its own
    await Promise.resolve();
    fire();
    const results = await pending;
    expect(results.map((r) => r.unheard)).toEqual([true, false]);
    expect(results[1]?.text).toBe("playing");
  });

  it("stops listening once a step has settled, so a later line cannot be attributed to it", async () => {
    const { io, handlers } = answeringIo((s) => ({ text: s.line, ok: true }));
    await runDirective([step("play", "playing")], io, 1000);
    expect(handlers.size).toBe(0);
  });

  it("does nothing at all with no steps", async () => {
    const { io, emitted } = answeringIo(() => ({ text: "x", ok: true }));
    expect(await runDirective([], io, 1000)).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

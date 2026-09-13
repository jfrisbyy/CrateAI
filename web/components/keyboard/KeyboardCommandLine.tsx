"use client";

// The sentence half of the instrument, in the panel itself so it works before
// the chat is wired to it. What is typed here is parsed by the same
// `parseKeyboardCommand` and put on the same bus the chat would use, so the
// two paths cannot drift apart: there is only one path.

import { useState } from "react";
import { btn, cx, input } from "@/components/ui";
import { emitKeyboardCommand, parseKeyboardCommand } from "@/lib/pads/commands";

export function KeyboardCommandLine({ echo }: { echo: { text: string; ok: boolean } | null }) {
  const [text, setText] = useState("");
  const [unparsed, setUnparsed] = useState<string | null>(null);

  const send = () => {
    const command = parseKeyboardCommand(text);
    if (!command) {
      setUnparsed(text.trim());
      return;
    }
    setUnparsed(null);
    emitKeyboardCommand(command);
    setText("");
  };

  return (
    <div className="mt-3 border-t border-rule pt-2">
      <div className="flex items-center gap-2">
        <input
          className={cx(input, "flex-1 min-w-[160px]")}
          value={text}
          placeholder="gate, note mode, 24 keys, sort the kit by hit class, tighten the take by 40%"
          onChange={(e) => {
            setText(e.target.value);
            setUnparsed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
            e.stopPropagation();
          }}
          onKeyUp={(e) => e.stopPropagation()}
          aria-label="Tell the instrument what to do"
        />
        <button type="button" className={btn} onClick={send}>
          Do it
        </button>
      </div>
      {echo && (
        <p className={cx("mt-1.5 text-xs", echo.ok ? "text-chalk-dim" : "text-chalk border-l-2 border-pad pl-2")} aria-live="polite">
          {echo.text}
        </p>
      )}
      {unparsed && (
        <p className="mt-1.5 text-xs text-chalk-dim">
          That is not one of the instrument&apos;s commands, so it would go to the chat as a question. The controls above are the whole vocabulary.
        </p>
      )}
    </div>
  );
}

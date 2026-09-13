"use client";

import { useState, type KeyboardEvent } from "react";
import { btnPrimary } from "@/components/ui";

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    await onSend(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="shrink-0 border-t border-rule p-3 flex flex-col gap-2 bg-slate"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find the 4-bar loop under the hook. What's the swing on this?"
        className="w-full resize-none bg-transparent text-sm placeholder:text-chalk-faint focus:outline-none"
        disabled={disabled}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-chalk-faint">Enter sends, Shift+Enter for a new line</span>
        <button type="submit" className={btnPrimary} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </div>
    </form>
  );
}

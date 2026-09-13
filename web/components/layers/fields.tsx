"use client";

// Small committed inputs for dense rows: a number that commits on blur or
// Enter (typing never fires a PATCH per keystroke), and an inline rename.

import { useEffect, useRef, useState } from "react";
import { cx, input } from "@/components/ui";

export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  digits = 2,
  placeholder,
  ariaLabel,
  widthClass = "w-[64px]",
  allowEmpty = false,
  disabled,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  placeholder?: string;
  ariaLabel: string;
  widthClass?: string;
  /** an empty field commits null (blank = auto / none) */
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  const format = (v: number | null) => (v === null ? "" : Number.isInteger(v) ? String(v) : String(Math.round(v * 10 ** digits) / 10 ** digits));
  const [text, setText] = useState(format(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (allowEmpty) {
        if (value !== null) onCommit(null);
      } else setText(format(value));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setText(format(value));
      return;
    }
    let next = n;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setText(format(next));
    if (value === null || Math.abs(next - value) > 1e-9) onCommit(next);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      className={cx(input, "font-mono h-6 text-xs text-right", widthClass)}
      value={text}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setText(format(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function NameField({ value, fallback, onCommit, ariaLabel }: { value: string | null; fallback: string; onCommit: (name: string | null) => void; ariaLabel: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed === (value ?? "")) return;
    onCommit(trimmed || null);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className={cx(input, "h-6 w-[240px]")}
        value={text}
        aria-label={ariaLabel}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setText(value ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="text-sm font-medium truncate text-left hover:text-pad max-w-[320px]"
      onClick={() => {
        setText(value ?? "");
        setEditing(true);
      }}
      title="Rename"
    >
      {value?.trim() || fallback}
    </button>
  );
}

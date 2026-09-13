"use client";

import { useEffect, useRef } from "react";
import { btn } from "@/components/ui";
import { KEYMAP } from "@/lib/keys/commands";

export function KeymapSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[420px] max-w-[calc(100vw-32px)] rounded-md border border-rule bg-graphite text-chalk p-0"
      aria-label="Keyboard map"
    >
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between">
        <h2 className="text-sm font-medium">Keyboard</h2>
        <button type="button" onClick={onClose} className={btn}>
          Close
        </button>
      </div>
      <dl className="px-4 py-2">
        {KEYMAP.map((row) => (
          <div key={row.keys} className="grid grid-cols-[88px_1fr] gap-3 py-1.5 border-b border-rule last:border-b-0">
            <dt className="font-mono text-sm text-chalk">{row.keys}</dt>
            <dd className="text-sm text-chalk-dim">{row.does}</dd>
          </div>
        ))}
      </dl>
      <p className="px-4 pb-3 text-xs text-chalk-faint">Keys are ignored while you are typing in a field.</p>
    </dialog>
  );
}

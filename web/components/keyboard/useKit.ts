"use client";

// The kit as React state. Every control on the panel and every sentence from
// the chat goes through these setters, which is what makes the two halves the
// same half: there is no path that changes how the keyboard plays without the
// control showing it.

import { useCallback, useMemo, useState } from "react";
import { defaultKit, setLayout, setNotePad, setPlay, setRootPad, setTrigger, swapPads, type PadKit, type PlayMode, type TriggerMode } from "@/lib/pads/kit";
import { layoutOr, padForKeyIn, type LayoutId } from "@/lib/pads/layouts";

export interface KitState {
  kit: PadKit;
  setTrigger: (mode: TriggerMode) => void;
  setPlay: (mode: PlayMode) => void;
  setLayout: (layout: LayoutId) => void;
  setRootPad: (pad: number) => void;
  /** "root on w": the same control, addressed by the key cap */
  setRootKey: (key: string) => boolean;
  setNotePad: (pad: number | null) => void;
  setOrder: (order: readonly number[]) => void;
  swap: (a: number, b: number) => void;
  reset: () => void;
}

export function useKit(initial?: PadKit): KitState {
  const [kit, setKit] = useState<PadKit>(() => initial ?? defaultKit());

  const setRootKey = useCallback(
    (key: string) => {
      let moved = false;
      setKit((current) => {
        const pad = padForKeyIn(layoutOr(current.layoutId), key);
        if (pad === null) return current;
        moved = true;
        return setRootPad(current, pad);
      });
      return moved;
    },
    [],
  );

  return useMemo<KitState>(
    () => ({
      kit,
      setTrigger: (mode) => setKit((k) => setTrigger(k, mode)),
      setPlay: (mode) => setKit((k) => setPlay(k, mode)),
      setLayout: (layout) => setKit((k) => setLayout(k, layout)),
      setRootPad: (pad) => setKit((k) => setRootPad(k, pad)),
      setRootKey,
      setNotePad: (pad) => setKit((k) => setNotePad(k, pad)),
      setOrder: (order) => setKit((k) => ({ ...k, order: [...order] })),
      swap: (a, b) => setKit((k) => swapPads(k, a, b)),
      reset: () => setKit((k) => defaultKit(k.layoutId)),
    }),
    [kit, setRootKey],
  );
}

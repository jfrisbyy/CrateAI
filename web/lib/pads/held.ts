// Which keys are down right now.
//
// Two things this exists for, and both of them hang a note if they are got
// wrong. A held key fires `keydown` over and over at the OS level, and in gate
// mode every repeat would retrigger the slice — so a pad already held ignores
// the repeat whether or not the browser sets `event.repeat`. And a key-up that
// never arrives (the tab loses focus mid-hold, the window is hidden, the
// producer alt-tabs) has to release anyway, which is what `releaseAll` is for.
//
// No DOM, no audio: the hook feeds it events and the engine gets the answer.

export type PadDownResult = "start" | "repeat";

export class HeldPads {
  private down = new Set<number>();
  /** the most keys held at once since the last reset; the polyphony readout */
  private peak = 0;

  /** Returns "start" the first time a pad goes down, "repeat" for every OS repeat until it comes up. */
  press(pad: number, repeat = false): PadDownResult {
    if (this.down.has(pad)) return "repeat";
    if (repeat) {
      // A repeat for a pad we never saw go down (focus arrived mid-hold):
      // take it as the start, so the key is not dead until it is released.
      this.down.add(pad);
      this.peak = Math.max(this.peak, this.down.size);
      return "start";
    }
    this.down.add(pad);
    this.peak = Math.max(this.peak, this.down.size);
    return "start";
  }

  /** True when the pad really was down; false for a stray key-up. */
  release(pad: number): boolean {
    return this.down.delete(pad);
  }

  /** Every held pad, released. The answer is what to cut: blur, hidden tab, stop, layout change. */
  releaseAll(): number[] {
    const pads = [...this.down];
    this.down.clear();
    return pads;
  }

  has(pad: number): boolean {
    return this.down.has(pad);
  }

  get size(): number {
    return this.down.size;
  }

  held(): number[] {
    return [...this.down];
  }

  get peakHeld(): number {
    return this.peak;
  }

  resetPeak(): void {
    this.peak = this.down.size;
  }
}

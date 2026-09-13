// Number and time formatting for readouts. Everything here renders in the
// mono face with tabular numerals; keep the outputs fixed-width where a value
// will change live (playhead, progress).

export function fmtBpm(bpm: number | null | undefined, digits = 1): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return "—";
  return bpm.toFixed(digits);
}

/** 0:07.250 style, fixed width, for positions and loop edges. */
export function fmtClock(seconds: number | null | undefined, msDigits = 3): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const frac = Math.round((rest - whole) * 10 ** msDigits);
  const carry = frac >= 10 ** msDigits;
  const wholeStr = String(carry ? whole + 1 : whole).padStart(2, "0");
  const fracStr = String(carry ? 0 : frac).padStart(msDigits, "0");
  return `${sign}${m}:${wholeStr}${msDigits > 0 ? `.${fracStr}` : ""}`;
}

/** 3:21 for durations in lists. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds with fixed decimals, e.g. "0.512 s". */
export function fmtSeconds(seconds: number | null | undefined, digits = 3): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(digits)} s`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function fmtPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

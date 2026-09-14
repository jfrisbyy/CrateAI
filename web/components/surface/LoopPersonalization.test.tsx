import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/types/db";
import {
  accountPersonalization,
  jobPersonalization,
  PersonalizationChip,
  PersonalizationNote,
  rowPersonalization,
} from "./LoopPersonalization";

/** What `LoopPreference.to_dict()` puts on a job result and on every adjusted row. */
const account = {
  enabled: true,
  neutral: false,
  n_corrections: 14,
  strength: 0.6,
  bar_prior_delta: { "4": -0.15, "8": 0.15 },
  term_delta: {},
  score_cap: 0.15,
  why: [
    "Learned from your last 14 loop corrections, at 60% of the most this is allowed to count.",
    "You keep ending up on 8 bars, so 8-bar loops rank higher for you (+0.15 on their prior).",
  ],
} satisfies Record<string, Json>;

const row = { ...account, applied: true, score_measured: 0.7781, delta: 0.0166, reasons: ["8 bars is a length you keep: +0.017"] };

describe("reading what the ranking did", () => {
  it("finds the account's part on a job result and on a loop row", () => {
    expect(jobPersonalization({ personalization: account } as Json)?.n_corrections).toBe(14);
    expect(rowPersonalization({ seam: 0.6, personalization: row } as Json)?.delta).toBeCloseTo(0.0166);
    expect(rowPersonalization({ seam: 0.6 } as Json)).toBeNull();
    expect(rowPersonalization(null)).toBeNull();
    expect(jobPersonalization(null)).toBeNull();
    expect(accountPersonalization({ why: ["no enabled flag, so not a personalization"] } as Json)).toBeNull();
  });
});

describe("PersonalizationChip", () => {
  it("shows how far this account's history moved the row, and the measured score beside it", () => {
    const html = renderToStaticMarkup(<PersonalizationChip personal={rowPersonalization({ personalization: row } as Json)!} />);
    expect(html).toContain('data-personal="up"');
    expect(html).toContain("0.017");
    expect(html).toContain("measured 0.778");
    expect(html).toContain("8 bars is a length you keep");
  });

  it("shows nothing on a row nothing moved", () => {
    const flat = { ...row, applied: false, delta: 0 };
    expect(renderToStaticMarkup(<PersonalizationChip personal={rowPersonalization({ personalization: flat } as Json)!} />)).toBe("");
  });
});

describe("PersonalizationNote", () => {
  const note = (personal: Parameters<typeof PersonalizationNote>[0]["personal"], enabled: boolean) =>
    renderToStaticMarkup(<PersonalizationNote personal={personal} enabled={enabled} busy={false} error={null} onToggle={() => {}} />);

  it("says how much of the rack is the producer's own, and offers the way out", () => {
    const html = note(accountPersonalization(account as Json)!, true);
    expect(html).toContain("your own 14 loop corrections");
    expect(html).toContain("0.15");
    expect(html).toContain("Turn off");
    expect(html).toContain("Why");
  });

  it("says plainly when the ranking is the measurement alone", () => {
    const off = note(accountPersonalization({ ...account, enabled: false } as Json)!, false);
    expect(off).toContain("personal loop ranking is off");
    expect(off).toContain("Turn on");

    const cold = note(accountPersonalization({ ...account, neutral: true, n_corrections: 0 } as Json)!, true);
    expect(cold).toContain("Ranked by the measurement alone");
    expect(cold).toContain("the next search learns from it");
  });
});

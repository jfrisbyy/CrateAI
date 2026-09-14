// The separator catalogue as the web reads it, and the quality it reports back.
//
// Separation is the one irreversible step in the product: a weak separator
// threw away 17.6 dB of 8-20 kHz energy on a real upload that a reference one
// preserved exactly, and no EQ downstream puts it back. So these tests hold two
// things — that the web cannot quietly offer a worse separator than the registry
// would pick, and that a producer is told what made their stems.

import { describe, expect, it } from "vitest";
import {
  ALL_STEMS,
  DEFAULT_SPLIT,
  describeAsk,
  describeStems,
  modelSpec,
  qualityOf,
  splitFor,
  splitKey,
  STEM_MODELS,
  STEM_ORDER,
  STEM_SPLITS,
  stemOrderIndex,
  stemQualityColumns,
  stemsAskKey,
  stemsAskOf,
  TIERS,
} from "./stems";
import type { StemRow } from "@/lib/types/db";

const row = (partial: Partial<StemRow> & { model: string }): StemRow => ({
  id: "s1",
  user_id: "u",
  file_id: "f",
  stem: "drums",
  stem_file_id: "sf",
  created_at: "2026-09-15T12:00:00.000Z",
  ...stemQualityColumns(partial.model),
  ...partial,
});

describe("the catalogue", () => {
  it("is the whole registry, not the three models the web used to name", () => {
    expect(STEM_MODELS.length).toBeGreaterThanOrEqual(6);
    expect(STEM_MODELS.map((m) => m.id)).toContain("mdx23c_inst_voc");
    expect(STEM_MODELS.map((m) => m.id)).toContain("mdxnet_inst_hq");
  });

  it("is ordered best first", () => {
    const rank = STEM_MODELS.map((m) => TIERS.indexOf(m.tier));
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
    expect(STEM_MODELS[0]?.tier).toBe("reference");
  });

  it("never carries an SDR without saying what the number is", () => {
    for (const m of STEM_MODELS) {
      if (m.sdr !== null) expect(m.sdrBasis.length).toBeGreaterThan(10);
    }
  });

  it("offers no split that a weak or stand-in model would have to make", () => {
    for (const split of STEM_SPLITS) {
      expect(["reference", "strong", "baseline"]).toContain(split.bestTier);
    }
  });

  it("routes the vocal split to the reference tier, which is what de-vocalling leans on", () => {
    const vocal = splitFor(["instrumental", "vocals"]);
    expect(vocal?.bestModel).toBe("bs_roformer");
    expect(vocal?.bestTier).toBe("reference");
  });

  it("has a default split, and it is the four-stem one", () => {
    expect(DEFAULT_SPLIT.isDefault).toBe(true);
    expect([...DEFAULT_SPLIT.stems].sort()).toEqual(["bass", "drums", "other", "vocals"]);
  });

  it("puts every stem the registry can return in the display order", () => {
    // STEM_ORDER is hand-written display preference; ALL_STEMS is generated. A
    // model that adds a stem must not fall off the end of the list silently.
    for (const stem of ALL_STEMS) expect(STEM_ORDER).toContain(stem);
    expect(stemOrderIndex("nothing-like-this")).toBe(STEM_ORDER.length);
  });
});

describe("splitKey", () => {
  it("does not care what order the stems arrive in", () => {
    expect(splitKey(["vocals", "instrumental"])).toBe(splitKey(["instrumental", "vocals"]));
  });

  it("does not care how many times one is repeated", () => {
    expect(splitKey(["vocals", "vocals", "instrumental"])).toBe(splitKey(["vocals", "instrumental"]));
  });

  it("keeps different splits apart", () => {
    expect(splitKey(["vocals", "instrumental"])).not.toBe(splitKey(["drums", "bass", "vocals", "other"]));
  });
});

describe("what a job asked for", () => {
  it("reads a split", () => {
    expect(stemsAskOf({ stems: ["vocals", "instrumental"] })).toEqual({ stems: ["vocals", "instrumental"], model: null });
  });

  it("reads a job queued under the old model-only shape", () => {
    expect(stemsAskKey(stemsAskOf({ model: "htdemucs_ft" }))).toBe("model:htdemucs_ft");
  });

  it("survives params that are not an object at all", () => {
    for (const junk of [null, undefined, 4, "stems", ["stems"]]) {
      expect(stemsAskKey(stemsAskOf(junk))).toBeNull();
    }
  });

  it("labels a job by what was asked for, never by which net ran", () => {
    expect(describeAsk(stemsAskOf({ stems: ["drums", "bass", "vocals", "other"] }))).toBe("drums, bass, vocals and other");
    expect(describeAsk(stemsAskOf({}))).toBe("stems");
  });
});

describe("describeStems", () => {
  it("writes a list the way a person would say it", () => {
    expect(describeStems(["vocals", "instrumental"])).toBe("vocals and instrumental");
    expect(describeStems(["drums"])).toBe("drums");
    expect(describeStems([])).toBe("nothing");
  });
});

describe("the quality a stem reports", () => {
  it("carries the tier, the SDR and its basis from the row", () => {
    const q = qualityOf(row({ model: "bs_roformer" }));
    expect(q.tier).toBe("reference");
    expect(q.sdr).toBe(12.98);
    expect(q.sdrBasis).toContain("published");
    expect(q.untrusted).toBe(false);
  });

  it("reads a null tier as unknown rather than as fine", () => {
    // 20260913000800_stem_quality.sql says so in as many words: a row that
    // predates the columns is untrusted, the same as 'weak'.
    const q = qualityOf(row({ model: "htdemucs_ft", model_tier: null, quality_note: null, quality_confidence: null }));
    expect(q.measured).toBe(false);
    expect(q.untrusted).toBe(true);
    expect(q.note).toContain("unknown");
  });

  it("marks the baseline tier untrusted, because it is audibly softer", () => {
    expect(qualityOf(row({ model: "mdxnet_inst_hq" })).untrusted).toBe(true);
  });

  it("marks the weak tier untrusted and says why, in a sentence", () => {
    const q = qualityOf(row({ model: "kuielab_other" }));
    expect(q.tier).toBe("weak");
    expect(q.untrusted).toBe(true);
    expect(q.note).toContain("cannot be recovered");
  });

  it("catches a stand-in from the model name even when the column says otherwise", () => {
    const q = qualityOf({ ...row({ model: "htdemucs_ft" }), model: "htdemucs_ft-fake", is_stand_in: false });
    expect(q.isStandIn).toBe(true);
    expect(q.untrusted).toBe(true);
  });

  it("gives a stand-in no SDR to quote", () => {
    expect(stemQualityColumns("bs_roformer-fake").model_sdr).toBeNull();
    expect(stemQualityColumns("bs_roformer-fake").model_tier).toBe("stand_in");
  });
});

describe("stemQualityColumns", () => {
  it("cannot invent a tier the registry does not give the model", () => {
    for (const m of STEM_MODELS) {
      expect(stemQualityColumns(m.id).model_tier).toBe(m.tier);
      expect(stemQualityColumns(m.id).model_sdr).toBe(m.sdr);
    }
  });

  it("treats a model it has never heard of as untrusted", () => {
    const cols = stemQualityColumns("some_model_from_the_future");
    expect(cols.model_tier).toBe("weak");
    expect(modelSpec("some_model_from_the_future")).toBeUndefined();
  });
});

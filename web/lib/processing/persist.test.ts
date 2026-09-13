// Processing is a property of a track and has to survive it. The reading half
// is deliberately forgiving: a song that will not open because of an EQ is a
// worse outcome than a song that opens flat.

import { describe as group, expect, it } from "vitest";
import { defaultMaster, defaultProcessing, setBand, setBypass, setLimiter, setTrim, setTune } from "./chain";
import { fromStored, fromStoredMaster, PROCESSING_VERSION, toStored, toStoredMaster } from "./persist";

function chain() {
  let processing = setBypass(defaultProcessing(), false);
  processing = setTrim(processing, -3);
  processing = setTune(processing, -18);
  processing = setBand(processing, "hp", { frequency: 80, enabled: true });
  processing = setBand(processing, "lo", { frequency: 250, gainDb: -4, q: 1.2, enabled: true });
  return processing;
}

group("the stored shape", () => {
  it("round-trips a chain exactly", () => {
    const before = chain();
    expect(fromStored(JSON.parse(JSON.stringify(toStored(before))))).toEqual(before);
  });

  it("carries a version, so a later shape can be told from this one", () => {
    expect(toStored(defaultProcessing()).version).toBe(PROCESSING_VERSION);
  });

  it("does not store a slot's shape, because its id already decides it", () => {
    const stored = toStored(defaultProcessing());
    expect(Object.keys(stored.bands[0] ?? {})).toEqual(["id", "frequency", "gainDb", "q", "enabled"]);
  });

  it("round-trips the master bus", () => {
    const master = setLimiter(defaultMaster(), { enabled: true, ceilingDb: -3, releaseMs: 200 });
    expect(fromStoredMaster(JSON.parse(JSON.stringify(toStoredMaster(master))))).toEqual(master);
  });
});

group("reading something that is not quite right", () => {
  it("reads nothing at all as no processing, rather than throwing", () => {
    for (const raw of [null, undefined, "x", 3, []]) expect(fromStored(raw)).toBeNull();
    expect(fromStoredMaster(null)).toEqual(defaultMaster());
  });

  it("fills in missing fields from the default chain", () => {
    const processing = fromStored({ version: 1, bands: [{ id: "lo", gainDb: -6, enabled: true }] });
    expect(processing?.bypassed).toBe(true);
    expect(processing?.trimDb).toBe(0);
    expect(processing?.bands).toHaveLength(7);
    expect(processing?.bands.find((b) => b.id === "lo")).toMatchObject({ gainDb: -6, enabled: true, frequency: 250 });
  });

  it("clamps numbers from a blob that was written with wider limits", () => {
    const processing = fromStored({ bypassed: false, trimDb: 99, tuneCents: -9000, bands: [{ id: "hs", gainDb: 40, frequency: 99000, q: 900, enabled: true }, { id: "hp", frequency: 5000, enabled: true }] });
    expect(processing?.trimDb).toBe(12);
    expect(processing?.tuneCents).toBe(-1200);
    expect(processing?.bands.find((b) => b.id === "hs")).toMatchObject({ gainDb: 12, frequency: 20000, q: 18 });
    expect(processing?.bands.find((b) => b.id === "hp")?.frequency).toBe(400);
  });

  it("ignores a band it has never heard of and keeps the ones it has", () => {
    const processing = fromStored({ bands: [{ id: "air", gainDb: 6, enabled: true }, { id: "mid", gainDb: -2, enabled: true }, 7, null] });
    expect(processing?.bands.map((b) => b.id)).toEqual(["hp", "ls", "lo", "mid", "hi", "hs", "lp"]);
    expect(processing?.bands.find((b) => b.id === "mid")?.gainDb).toBe(-2);
  });

  it("keeps a stored slot's shape right even if the blob claims another one", () => {
    const processing = fromStored({ bands: [{ id: "hp", kind: "peaking", gainDb: 9, frequency: 100, enabled: true }] });
    const hp = processing?.bands.find((b) => b.id === "hp");
    expect(hp?.kind).toBe("highpass");
    expect(hp?.gainDb).toBe(0);
  });

  it("will not read back a master that is bypassed and limiting at the same time", () => {
    const master = fromStoredMaster({ bypassed: true, limiter: { enabled: true, ceilingDb: -1, releaseMs: 120 } });
    expect(master.bypassed).toBe(false);
  });
});

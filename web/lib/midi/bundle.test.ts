import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { BUNDLE_CAP_BYTES, BundleTooLargeError, MANIFEST_NAME, assertUnderCap, buildBundleZip } from "./bundle";
import type { BundleManifest } from "./manifest";

const manifest: BundleManifest = {
  file: { id: "f", name: "x.wav", bpm: 90, key: null },
  chops: [{ index: 0, name: "chop 1", filename: "chops/x_chop01.wav", start_s: 0, end_s: 1 }],
  midi: [{ kind: "drums", filename: "midi/pads.mid" }],
  generated_at: "2026-09-13T00:00:00.000Z",
};

describe("buildBundleZip", () => {
  it("zips the files with the manifest and unzips back byte for byte", () => {
    const wav = new Uint8Array(1000).map((_, i) => i % 251);
    const mid = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const zip = buildBundleZip(
      [
        { zip_path: "chops/x_chop01.wav", bytes: wav },
        { zip_path: "midi/pads.mid", bytes: mid },
      ],
      manifest,
    );
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(["chops/x_chop01.wav", MANIFEST_NAME, "midi/pads.mid"].sort());
    expect(out["chops/x_chop01.wav"]).toEqual(wav);
    expect(out["midi/pads.mid"]).toEqual(mid);
    expect(JSON.parse(strFromU8(out[MANIFEST_NAME]!))).toEqual(manifest);
  });

  it("refuses more than the cap", () => {
    expect(() => assertUnderCap(BUNDLE_CAP_BYTES)).not.toThrow();
    expect(() => assertUnderCap(BUNDLE_CAP_BYTES + 1)).toThrow(BundleTooLargeError);
  });
});

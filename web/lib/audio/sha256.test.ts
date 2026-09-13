import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256, sha256Blob, sha256Hex } from "./sha256";

function nodeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic pseudo-random bytes (xorshift32) so failures reproduce. */
function bytes(n: number, seed = 0x9e3779b9): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("sha256", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it.each([0, 1, 3, 55, 56, 57, 63, 64, 65, 100, 1000, 4096, 65_537, (1 << 20) + 7, 3 * (1 << 20) + 123])(
    "matches node crypto for %d bytes",
    (n) => {
      const data = bytes(n, n + 1);
      expect(sha256Hex(data)).toBe(nodeSha256(data));
    },
  );

  it("is independent of how the input is chunked", () => {
    const data = bytes((1 << 20) + 999, 42);
    const expected = nodeSha256(data);
    for (const chunk of [1, 7, 63, 64, 65, 100, 4093, 65_536]) {
      const h = new Sha256();
      for (let off = 0; off < data.length; off += chunk) h.update(data.subarray(off, off + chunk));
      expect(h.hex(), `chunk size ${chunk}`).toBe(expected);
    }
  });

  it("handles views with a non-zero byte offset", () => {
    const backing = bytes(2000, 7);
    const view = backing.subarray(13, 1900);
    expect(sha256Hex(view)).toBe(nodeSha256(view));
  });

  it("refuses updates after digest", () => {
    const h = new Sha256().update(bytes(10));
    h.hex();
    expect(() => h.update(bytes(1))).toThrow();
  });

  it("hashes a Blob in slices with progress", async () => {
    const data = bytes(3 * 1024 * 1024 + 5, 99);
    const blob = new Blob([data]);
    const seen: number[] = [];
    const hex = await sha256Blob(blob, (done) => seen.push(done), 1024 * 1024);
    expect(hex).toBe(nodeSha256(data));
    expect(seen).toEqual([1024 * 1024, 2 * 1024 * 1024, 3 * 1024 * 1024, data.length]);
  });

  it("hashes an empty Blob", async () => {
    expect(await sha256Blob(new Blob([]))).toBe(nodeSha256(new Uint8Array()));
  });
});

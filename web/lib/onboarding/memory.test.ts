import { describe, expect, it } from "vitest";
import {
  EMPTY_MEMORY,
  isNewSession,
  MEMORY_KEY,
  parseMemory,
  readMemory,
  serializeMemory,
  SESSION_GAP_MS,
  writeMemory,
  type OnboardingMemory,
} from "./memory";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

class BrokenStorage extends FakeStorage {
  override getItem(): string {
    throw new Error("site data is blocked");
  }
  override setItem(): void {
    throw new Error("site data is blocked");
  }
}

const memory: OnboardingMemory = {
  version: 1,
  dismissedAt: "2026-09-13T10:00:00.000Z",
  firstReadyFileId: "file-1",
  firstReadyAt: "2026-09-13T09:00:00.000Z",
  lastFileId: "file-2",
  lastSeenAt: "2026-09-13T09:30:00.000Z",
  seenConstraint: true,
};

describe("what the first run remembers", () => {
  it("round-trips", () => {
    expect(parseMemory(serializeMemory(memory))).toEqual(memory);
  });

  it("survives nothing, rubbish, and another version's shape", () => {
    expect(parseMemory(null)).toEqual(EMPTY_MEMORY);
    expect(parseMemory("")).toEqual(EMPTY_MEMORY);
    expect(parseMemory("not json")).toEqual(EMPTY_MEMORY);
    expect(parseMemory("[1,2,3]")).toEqual(EMPTY_MEMORY);
    expect(parseMemory('{"dismissedAt":42,"seenConstraint":"yes"}')).toEqual(EMPTY_MEMORY);
    expect(parseMemory('{"version":9,"firstReadyFileId":"f","extra":true}')).toEqual({
      ...EMPTY_MEMORY,
      firstReadyFileId: "f",
    });
  });

  it("reads and writes one key, and shrugs when storage is blocked", () => {
    const store = new FakeStorage();
    writeMemory(memory, store);
    expect(store.getItem(MEMORY_KEY)).toContain("file-1");
    expect(readMemory(store)).toEqual(memory);

    const broken = new BrokenStorage();
    expect(() => writeMemory(memory, broken)).not.toThrow();
    expect(readMemory(broken)).toEqual(EMPTY_MEMORY);
  });
});

describe("what counts as coming back", () => {
  const at = (iso: string) => new Date(iso);

  it("is not a return the first time, and not a refresh", () => {
    expect(isNewSession(EMPTY_MEMORY, at("2026-09-14T00:00:00Z"))).toBe(false);
    expect(isNewSession({ ...memory, lastSeenAt: "2026-09-13T09:55:00Z" }, at("2026-09-13T10:00:00Z"))).toBe(false);
  });

  it("is a return after the gap", () => {
    const last = "2026-09-13T09:00:00Z";
    const justUnder = new Date(Date.parse(last) + SESSION_GAP_MS - 1000);
    const justOver = new Date(Date.parse(last) + SESSION_GAP_MS + 1000);
    expect(isNewSession({ ...memory, lastSeenAt: last }, justUnder)).toBe(false);
    expect(isNewSession({ ...memory, lastSeenAt: last }, justOver)).toBe(true);
  });

  it("treats an unreadable timestamp as no information", () => {
    expect(isNewSession({ ...memory, lastSeenAt: "yesterday" }, at("2026-09-14T00:00:00Z"))).toBe(false);
  });
});

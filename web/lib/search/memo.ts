// A small TTL memo. The search box asks the route twice for one query (once
// for the library pane through the shell's search state, once for the matched
// fields), so the second answer within the window is free: no second Claude
// parse, no second embed call.

export class TtlMemo<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, at: this.now() });
  }
}

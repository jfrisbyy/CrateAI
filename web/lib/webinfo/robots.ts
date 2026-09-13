// robots.txt (OPEN_QUESTIONS F.25): fetched once per host and cached, parsed
// into groups, and consulted before every page fetch. A path the site
// disallows is skipped and the chat says so. When robots.txt cannot be read
// the site is treated as open (that is the convention).

import type { Fetcher } from "./types";
import { USER_AGENT } from "./types";

export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

/** The token sites would name us by; "*" is the fallback group. */
export const ROBOTS_AGENT = "crateai";

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow") {
      if (value) current.disallow.push(value);
    } else if (field === "allow") {
      if (value) current.allow.push(value);
    }
  }
  return { groups };
}

function patternToRegExp(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re);
}

function pickGroup(rules: RobotsRules, agent: string): RobotsGroup | null {
  const token = agent.toLowerCase();
  let fallback: RobotsGroup | null = null;
  for (const g of rules.groups) {
    if (g.agents.some((a) => a !== "*" && (token.includes(a) || a.includes(token)))) return g;
    if (!fallback && g.agents.includes("*")) fallback = g;
  }
  return fallback;
}

/** Longest matching rule wins; on a tie, allow wins. No matching rule means allowed. */
export function isAllowed(rules: RobotsRules, path: string, agent = ROBOTS_AGENT): boolean {
  const group = pickGroup(rules, agent);
  if (!group) return true;
  let best: { length: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!patternToRegExp(p).test(path)) continue;
      const length = p.length;
      if (!best || length > best.length || (length === best.length && allow && !best.allow)) best = { length, allow };
    }
  };
  consider(group.disallow, false);
  consider(group.allow, true);
  return best === null ? true : (best as { allow: boolean }).allow;
}

export interface RobotsVerdict {
  allowed: boolean;
  cached: boolean;
}

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_TIMEOUT_MS = 5_000;

/** One robots.txt request per host per day, in memory. */
export class RobotsCache {
  private readonly hosts = new Map<string, { rules: RobotsRules; at: number }>();
  constructor(
    private readonly fetcher: Fetcher,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async rulesFor(origin: string): Promise<{ rules: RobotsRules; cached: boolean }> {
    const hit = this.hosts.get(origin);
    if (hit && this.now() - hit.at < ROBOTS_TTL_MS) return { rules: hit.rules, cached: true };
    let rules: RobotsRules = { groups: [] };
    try {
      const res = await this.fetcher(`${origin}/robots.txt`, {
        method: "GET",
        headers: { accept: "text/plain", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      });
      if (res.ok) {
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!type || type.startsWith("text/")) rules = parseRobots(await res.text());
      }
    } catch {
      // unreadable robots.txt: open by convention
    }
    this.hosts.set(origin, { rules, at: this.now() });
    return { rules, cached: false };
  }

  async check(url: URL): Promise<RobotsVerdict> {
    const { rules, cached } = await this.rulesFor(url.origin);
    return { allowed: isAllowed(rules, `${url.pathname}${url.search}`), cached };
  }
}

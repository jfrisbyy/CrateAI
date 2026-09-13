// Readable text from an HTML page: scripts, styles, navigation and chrome
// dropped; headings and paragraphs kept, one per line; entities decoded;
// capped so a long article stays inside a tool result.

export const MAX_TEXT_CHARS = 40_000;

const DROP_ELEMENTS = ["head", "title", "script", "style", "noscript", "template", "svg", "canvas", "iframe", "nav", "header", "footer", "aside", "form", "button"];
const BLOCK_ELEMENTS = ["p", "div", "section", "article", "main", "li", "ul", "ol", "tr", "td", "th", "table", "blockquote", "pre", "figure", "figcaption", "dd", "dt", "dl", "hr", "br"];

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[lower] ?? m;
  });
}

function stripElements(html: string, names: string[]): string {
  let out = html;
  for (const name of names) {
    out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), " ");
    // self-closing or unclosed forms
    out = out.replace(new RegExp(`<${name}\\b[^>]*\\/?>`, "gi"), " ");
  }
  return out;
}

export function titleOf(html: string, fallback: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const raw = m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  if (raw) return raw.slice(0, 200);
  const og = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim().slice(0, 200);
  return fallback;
}

/** HTML -> lines of text. Headings become "# heading" lines so structure survives. */
export function extractText(html: string, cap = MAX_TEXT_CHARS): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = stripElements(s, DROP_ELEMENTS);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, _level: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    return text ? `\n\n# ${text}\n\n` : "\n";
  });
  for (const name of BLOCK_ELEMENTS) {
    s = s.replace(new RegExp(`<\\/?${name}\\b[^>]*>`, "gi"), "\n");
  }
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/[ \t\r\f\v ]+/g, " ")
        // an inline tag became a space; "Someone ." reads as "Someone."
        .replace(/ ([.,;:!?)\]])/g, "$1")
        .replace(/([(\[]) /g, "$1")
        .trim(),
    )
    .filter((line) => line.length > 0);
  let text = lines.join("\n");
  if (text.length > cap) text = `${text.slice(0, cap - 1)}…`;
  return text;
}

/** Plain text and JSON are kept as they are, whitespace-normalized and capped. */
export function extractPlain(body: string, cap = MAX_TEXT_CHARS): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** The first sentence of a snippet, as written, for a finding. */
export function firstSentence(snippet: string, maxChars = 240): string {
  const clean = snippet.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(clean);
  const sentence = m?.[1] ?? clean;
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}

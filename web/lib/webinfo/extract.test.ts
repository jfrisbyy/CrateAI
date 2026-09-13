import { describe, expect, it } from "vitest";
import { decodeEntities, extractText, firstSentence, MAX_TEXT_CHARS, titleOf } from "./extract";

describe("extract", () => {
  it("keeps headings and paragraphs, drops scripts, styles and navigation", () => {
    const html = `<html><head><title>T</title><style>.a{}</style><script>var x=1;</script></head>
    <body><header>site header</header><nav><a>Home</a></nav>
    <main><h2>Credits &amp; notes</h2><p>Line one.</p><div>Line <em>two</em>.</div><ul><li>bullet</li></ul></main>
    <aside>related</aside><footer>&copy; 2026</footer></body></html>`;
    const text = extractText(html);
    expect(text.split("\n")).toEqual(["# Credits & notes", "Line one.", "Line two.", "bullet"]);
  });

  it("caps at 40k characters", () => {
    const text = extractText(`<p>${"x".repeat(50_000)}</p>`);
    expect(text.length).toBe(MAX_TEXT_CHARS);
  });

  it("decodes entities and reads the title", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x41; &nbsp;d")).toBe("a & b 'c' A  d");
    expect(titleOf("<title> Hello &amp; bye </title>", "fallback")).toBe("Hello & bye");
    expect(titleOf("<meta property=\"og:title\" content=\"OG\">", "fallback")).toBe("OG");
    expect(titleOf("<p>none</p>", "fallback")).toBe("fallback");
  });

  it("takes the first sentence of a snippet", () => {
    expect(firstSentence("Produced by Someone. Recorded in 1976.")).toBe("Produced by Someone.");
    expect(firstSentence("no punctuation at all")).toBe("no punctuation at all");
    expect(firstSentence("")).toBe("");
  });
});

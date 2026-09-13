import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfidenceDot } from "./ConfidenceDot";

describe("ConfidenceDot", () => {
  it("renders three levels and nothing for unmeasured values", () => {
    expect(renderToStaticMarkup(<ConfidenceDot confidence={0.9} />)).toContain('data-level="full"');
    expect(renderToStaticMarkup(<ConfidenceDot confidence={0.7} />)).toContain('data-level="half"');
    expect(renderToStaticMarkup(<ConfidenceDot confidence={0.3} />)).toContain('data-level="low"');
    expect(renderToStaticMarkup(<ConfidenceDot confidence={null} />)).toBe("");
  });

  it("puts the hedge word in the accessible label", () => {
    expect(renderToStaticMarkup(<ConfidenceDot confidence={0.65} />)).toContain("confidence 0.65 (likely)");
    expect(renderToStaticMarkup(<ConfidenceDot confidence={0.95} />)).toContain('aria-label="confidence 0.95"');
  });
});

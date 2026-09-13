import { describe, expect, it } from "vitest";
import { INPUT_SCHEMAS } from "./handlers";
import { BATCH_GPU_CONFIRM, CHAT_TOOLS, GPU_TOOLS, TOOL_NAMES } from "./tools";

const PACKET_TOOLS = [
  "get_report", "find_loops", "create_loop", "render_loop", "separate_stems", "chop", "extract_midi", "layer", "revoice",
  "breakdown", "compare", "search", "web_search", "fetch_page", "identify_context", "set_edit", "explain", "batch",
];

function walk(schema: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  visit(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
    else if (v && typeof v === "object") walk(v, visit);
  }
}

describe("tool definitions", () => {
  it("covers every tool in BUILD_PACKET section 14 (plus embed)", () => {
    for (const name of PACKET_TOOLS) expect(TOOL_NAMES).toContain(name);
    expect(TOOL_NAMES).toContain("embed");
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("is strict: every object declares required and additionalProperties false", () => {
    for (const t of CHAT_TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect(Array.isArray(t.input_schema.required)).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      walk(t.input_schema, (node) => {
        if (node.type === "object") expect(node.additionalProperties, `${t.name}: an object without additionalProperties=false`).toBe(false);
      });
      expect(t.description?.length ?? 0).toBeGreaterThan(80);
      expect(t.description).toMatch(/never|cannot|does not|refuses|only/i);
    }
  });

  it("has a zod schema for every tool and a tool for every zod schema", () => {
    expect(Object.keys(INPUT_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of CHAT_TOOLS) {
      const declared = Object.keys((t.input_schema.properties ?? {}) as Record<string, unknown>).sort();
      const zodKeys = Object.keys(INPUT_SCHEMAS[t.name as keyof typeof INPUT_SCHEMAS].shape).sort();
      expect(zodKeys, t.name).toEqual(declared);
    }
  });

  it("names the GPU tools and the confirmation threshold", () => {
    expect([...GPU_TOOLS].sort()).toEqual(["embed", "revoice", "separate_stems"]);
    expect(BATCH_GPU_CONFIRM).toBe(5);
  });
});

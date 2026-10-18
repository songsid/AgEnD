/**
 * #2155: every agent-facing tool schema stays in the JSON Schema subset every MCP client converts the same way.
 * `z.tuple` emitted `prefixItems` (2020-12; `$schema` is stripped before sending), and codex 0.162 declared those
 * parameters as `Array<string>`, so every call that followed the declaration was refused. The real codex declarations,
 * captured offline (scripts/manual/tool-schema-codex-2155), showed that as the ONLY lossy construct in the 78 tools;
 * this walks the emitted schemas so it, and its relatives, cannot come back.
 */
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";

/** Keywords a draft-07 reader does not know (or reads differently), or that point at definitions we strip. */
const NOT_PORTABLE = ["prefixItems", "$ref", "$defs", "definitions", "$schema", "$dynamicRef", "unevaluatedItems", "unevaluatedProperties",
  "dependentSchemas", "dependentRequired", "if", "then", "else", "contains", "minContains", "maxContains"];

function problems(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) { node.forEach((n, i) => problems(n, `${path}[${i}]`, out)); return; }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const isSchema = ["type", "anyOf", "oneOf", "items", "properties", ...NOT_PORTABLE].some(k => k in o);
  if (isSchema) {
    for (const k of NOT_PORTABLE) if (k in o) out.push(`${path}: ${k}`);
    if (o.items === false) out.push(`${path}: items: false`);
    if (o.type === "array") {
      const items = o.items as Record<string, unknown> | undefined;
      if (!items || typeof items !== "object") out.push(`${path}: an array without an item schema`);
      else if (!("type" in items) && !("anyOf" in items) && !("oneOf" in items)) out.push(`${path}: an array whose items have no type`);
    }
    if (Array.isArray(o.type)) out.push(`${path}: a type list`);
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "description" || k === "enum" || k === "const" || k === "default" || k === "examples") continue;
    problems(v, path ? `${path}.${k}` : k, out);
  }
}

describe("#2155: agent tool schemas every MCP client reads the same way", () => {
  it("no tool schema uses prefixItems, items: false, references, 2020-12-only keywords, or an untyped array", () => {
    const found: string[] = [];
    for (const t of TOOLS) problems(t.inputSchema, t.name, found);
    expect(found).toEqual([]);
  });
  it("the guard sees what it guards against (a tuple, items: false, a reference, an untyped array, a type list)", () => {
    const found: string[] = [];
    problems({ type: "object", properties: {
      r: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false },
      ref: { $ref: "#/$defs/x" },
      bare: { type: "array" },
      loose: { type: "array", items: {} },
      either: { type: ["string", "null"] },
    } }, "t", found);
    expect(found.sort()).toEqual([
      "t.properties.bare: an array without an item schema",
      "t.properties.either: a type list",
      "t.properties.loose: an array whose items have no type",
      "t.properties.r: an array without an item schema",
      "t.properties.r: items: false",
      "t.properties.r: prefixItems",
      "t.properties.ref: $ref",
    ]);
  });
  it("set_web_ambient's ranges are plain number arrays of fixed length", () => {
    const p = TOOLS.find(t => t.name === "set_web_ambient")!.inputSchema.properties as Record<string, any>;
    for (const [k, n] of [["duration", 2], ["size", 2], ["spread", 2], ["opacity", 3]] as const) {
      expect({ type: p[k].type, items: p[k].items, minItems: p[k].minItems, maxItems: p[k].maxItems }, k).toEqual({ type: "array", items: { type: "number" }, minItems: n, maxItems: n });
    }
  });
});

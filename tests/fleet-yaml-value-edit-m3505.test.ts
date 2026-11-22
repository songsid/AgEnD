import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { parseDocument } from "yaml";
import { stringifyFleetYaml } from "../src/fleet-yaml-stringify.js";
import { detachForWrite } from "../src/yaml-shared-nodes.js";
import { FleetManager } from "../src/fleet-manager.js";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/fleet-yaml-value-edit-m3505/${name}.yaml`, import.meta.url), "utf8");
function edit(source: string, changes: Array<[Array<string | number>, unknown]>) {
  const doc = parseDocument(source, { keepSourceTokens: true });
  expect(doc.errors).toEqual([]);
  for (const [path, value] of changes) { detachForWrite(doc, path); doc.setIn(path, value); }
  return { doc, result: stringifyFleetYaml(doc, source) };
}

it.each(["flow", "block"])("replaces just two scalar values in %s mappings without reflowing any other bytes", name => {
  const source = fixture(name), { result } = edit(source, [[["monitoring", "enabled"], true], [["monitoring", "agent_footprint"], true]]);
  expect(result).toBe(source.replace(/false/g, "true"));
  const monitoring = (yaml.load(result) as any).monitoring;
  expect(monitoring).toEqual({ enabled: true, agent_footprint: true });
});
it("mixes scalar edits and added keys at the end of block mappings, retaining CRLF and comments", () => {
  const source = "settings:\r\n  enabled: false # choice\r\nother: {\r\n  keep: true,\r\n}\r\n";
  expect(edit(source, [[["settings", "enabled"], true], [["settings", "extra"], false]]).result)
    .toBe(source.replace("false # choice", "true # choice").replace("other:", "  extra: false\r\nother:"));
});
it("edits a scalar inside an existing sequence without reformatting its flow container", () => {
  const source = "items: [\n  { enabled: false, name: example },\n  false, # other choice\n]\n";
  expect(edit(source, [[["items", 0, "enabled"], true], [["items", 1], true]]).result).toBe(source.replace(/false/g, "true"));
});
it("keeps unrelated aliases and can replace a scalar alias token without changing its anchor", () => {
  const source = fixture("aliases"), { result } = edit(source, [[["monitoring", "agent_footprint"], true]]);
  expect(result).toBe(source.replace("*off # footprint", "true # footprint"));
  expect((yaml.load(result) as any).monitoring).toEqual({ enabled: false, agent_footprint: true });
});
it("isolates an anchored scalar edit by materializing only its other scalar alias value", () => {
  const source = fixture("aliases"), { result } = edit(source, [[["monitoring", "enabled"], true]]);
  expect(result).toBe(source.replace("false # monitoring", "true # monitoring").replace("*off # footprint", "false # footprint"));
  expect((yaml.load(result) as any).monitoring).toEqual({ enabled: true, agent_footprint: false });
});
it.each(["name: old\n", "name: 'old' # keep\n", 'name: "old" # keep\n'])("quotes a changed string safely without touching its comment or neighbours (%s)", line => {
  const source = line + "other: {\n  enabled: true,\n}\n", value = "true: # a 'quoted' string\nsecond line";
  const { result } = edit(source, [[["name"], value]]);
  expect(result).toBe(source.replace(/'old'|"old"|old/, JSON.stringify(value)));
  expect((yaml.load(result) as any).name).toBe(value);
});
it("replaces a block scalar's own range, preserving its header comment and following mapping", () => {
  const source = "name: | # keep header\n  old text\n  more text\nother: {\n  enabled: false,\n}\n";
  expect(edit(source, [[["name"], "new\ntext"]]).result).toBe('name: "new\\ntext" # keep header\nother: {\n  enabled: false,\n}\n');
});
it.each(["empty: # keep\n", "empty:\n", "empty: null # keep\n"])("writes an explicit value over null without consuming its comment or next line (%s)", source => {
  const { result } = edit(source + "other: { x: 1,\n y: 2 }\n", [[["empty"], true]]);
  expect(result).toBe(source.replace(/empty:(?: null)?/, "empty: true") + "other: { x: 1,\n y: 2 }\n");
});
it.each(["remove", "sequence", "mapping-alias"])("uses the safe AST fallback for a structural %s edit", kind => {
  const source = "first: &shared { enabled: false }\nother: *shared\nitems: [one,two]\n", doc = parseDocument(source, { keepSourceTokens: true });
  if (kind === "remove") doc.deleteIn(["items"]);
  else if (kind === "sequence") doc.setIn(["items"], ["one"]);
  else { detachForWrite(doc, ["other", "enabled"]); doc.setIn(["other", "enabled"], true); }
  const result = stringifyFleetYaml(doc, source);
  expect(result).toBe(doc.toString({ lineWidth: 0 }));
  expect(parseDocument(result).toJS()).toEqual(doc.toJS());
});
it("the actual Fleet saver toggles supported web values without reflow and reloads idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-value-edit-")); dirs.push(dir);
  const path = join(dir, "fleet.yaml"), source = fixture("flow")
    .replace(/^web:/m, "unknown_extension:")
    .replace(/^monitoring:/m, "web:")
    .replace("enabled: false", "usage_panel: false")
    .replace("agent_footprint: false", "echo_to_channel: false");
  writeFileSync(path, source);
  const fm = new FleetManager(dir); fm.loadConfig(path);
  fm.fleetConfig!.web = { ...fm.fleetConfig!.web, usage_panel: true, echo_to_channel: true };
  fm.saveFleetConfig();
  const result = readFileSync(path, "utf8"); expect(result).toBe(source.replace(/false/g, "true"));
  const saved = yaml.load(result) as any;
  expect(saved.web).toEqual({ usage_panel: true, echo_to_channel: true });
  const reloaded = new FleetManager(dir); reloaded.loadConfig(path);
  expect(reloaded.fleetConfig!.web).toMatchObject(saved.web);
  fm.saveFleetConfig(); expect(readFileSync(path, "utf8")).toBe(result);
});

it.each([
  ["map", "other:\n  nested:\n    value: *off # keep independently false\n"],
  ["sequence", "other:\n  - *off # keep independently false\n  - nested: [*off] # second copy\n"],
])("reaches materialized scalar aliases under an equal-data sibling %s", (_kind, sibling) => {
  const source = "monitoring:\n  enabled: &off false # choice\n" + sibling + "web: {\n  guests: { chat: true, },\n}\n";
  const { result } = edit(source, [[["monitoring", "enabled"], true]]);
  expect(result).toBe(source.replace("false # choice", "true # choice").replace(/\*off/g, "false"));
  expect((yaml.load(result) as any).monitoring.enabled).toBe(true);
});

it.each([["Tide", "Tide"], ["one,two", '"one,two"']])("uses context-safe YAML scalar spelling for %s without touching its flow neighbours", (value, spelling) => {
  const source = "settings: {\n  name: before, # own comment\n  keep: true,\n}\n";
  const { result } = edit(source, [[["settings", "name"], value]]);
  expect(result).toBe(source.replace("before", spelling));
  expect((yaml.load(result) as any).settings.name).toBe(value);
});
it("uses the original schema when quoting an otherwise ambiguous scalar", () => {
  const source = "%YAML 1.1\n---\nname: before # keep\nother: {\n  untouched: true,\n}\n";
  const { result } = edit(source, [[["name"], "yes"]]);
  expect(parseDocument(result).toJS().name).toBe("yes");
  expect(result.slice(result.indexOf("other:"))).toBe(source.slice(source.indexOf("other:")));
});

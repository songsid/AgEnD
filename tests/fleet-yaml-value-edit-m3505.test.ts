import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { parseDocument } from "yaml";
import { stringifyFleetYaml } from "../src/fleet-yaml-stringify.js";
import { detachForWrite } from "../src/yaml-shared-nodes.js";
import { FleetManager } from "../src/fleet-manager.js";
import { monitoringConfig as beta16 } from "./fixtures/host-monitoring-beta16/host-monitoring-config.js";
import { monitoringConfig as beta17 } from "./fixtures/host-monitoring-beta17/host-monitoring-config.js";
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
  expect(beta16(monitoring)).toEqual({ enabled: true, agent_footprint: true });
  expect(beta17(monitoring)).toEqual({ enabled: true, agent_footprint: true });
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
it("the actual Fleet saver toggles values in place and both shipped readers still accept the bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-value-edit-")); dirs.push(dir);
  const path = join(dir, "fleet.yaml"), source = fixture("flow"); writeFileSync(path, source);
  const fm = new FleetManager(dir); fm.loadConfig(path);
  fm.fleetConfig!.monitoring = { enabled: true, agent_footprint: true };
  fm.saveFleetConfig();
  const result = readFileSync(path, "utf8"); expect(result).toBe(source.replace(/false/g, "true"));
  const saved = yaml.load(result) as any;
  expect(beta16(saved.monitoring)).toEqual(fm.fleetConfig!.monitoring); expect(beta17(saved.monitoring)).toEqual(fm.fleetConfig!.monitoring);
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

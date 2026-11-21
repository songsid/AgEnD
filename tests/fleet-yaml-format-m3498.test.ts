import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { parseDocument } from "yaml";
import { stringifyFleetYaml } from "../src/fleet-yaml-stringify.js";
import { detachForWrite } from "../src/yaml-shared-nodes.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const long = "An example instruction with enough words to exceed eighty columns while remaining on the exact single line chosen by its owner.";
function fixture(section = "") {
  const root = mkdtempSync(join(tmpdir(), "fleet-yaml-format-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const source = `# hand-edited example\ndefaults:\n  systemPrompt: "${long}" # keep long line\ninstances: { example: { working_directory: /tmp/example-project, backend: codex } } # inline map\nunknown_extension: {compact: true,items: [one,two]} # keep compact spacing\n${section}`;
  writeFileSync(path, source);
  const fm = new FleetManager(root); fm.loadConfig(path);
  return { fm, path, source };
}
it.each(["", "web:\n  usage_panel: false  # keep aligned comment\n"])("add-only saves preserve every existing line and reload (%s)", section => {
  const { fm, path, source } = fixture(section);
  fm.fleetConfig!.web = { ...fm.fleetConfig!.web, usage_panel: false, echo_to_channel: false };
  fm.saveFleetConfig();
  const result = readFileSync(path, "utf8");
  const oldLines = source.split("\n").slice(0, -1), newLines = result.split("\n");
  expect(newLines.slice(0, oldLines.length)).toEqual(oldLines);
  const saved = yaml.load(result) as any;
  expect(saved.web).toEqual({ usage_panel: false, echo_to_channel: false });
  expect(saved.defaults.systemPrompt).toBe(long);
  expect(saved.unknown_extension).toEqual({ compact: true, items: ["one", "two"] });
  const reloaded = new FleetManager((fm as any).dataDir); reloaded.loadConfig(path);
  expect(reloaded.fleetConfig!.instances.example.backend).toBe("codex");
  expect(reloaded.fleetConfig!.web).toMatchObject({ usage_panel: false, echo_to_channel: false });
  fm.saveFleetConfig(); expect(readFileSync(path, "utf8")).toBe(result);
});

function add(source: string, path: Array<string | number>, value: unknown): string {
  const doc = parseDocument(source, { keepSourceTokens: true });
  detachForWrite(doc, path); doc.setIn(path, value !== null && typeof value === "object" ? doc.createNode(value) : value);
  return stringifyFleetYaml(doc, source);
}
it("inserts nested block keys before the next section, retaining CRLF, comments and irregular spacing", () => {
  const source = "# header\r\nmonitoring:\r\n  enabled: false  # keep\r\n# next section\r\nother:    {x: 1,y: 2}\r\n";
  expect(add(source, ["monitoring", "agent_footprint"], false)).toBe(source.replace("# next section", "  agent_footprint: false\r\n# next section"));
});
it.each(["leaf", "mapping"])("adds inside a flow collection without changing an unrelated line or losing its comment (%s)", how => {
  const source = "monitoring: {enabled: false}  # keep flow comment\nother:    {x: 1,y: 2}\n";
  const result = how === "leaf" ? add(source, ["monitoring", "agent_footprint"], false)
    : add(source, ["monitoring"], { enabled: false, agent_footprint: false });
  expect(result).toBe("monitoring: { enabled: false, agent_footprint: false }  # keep flow comment\nother:    {x: 1,y: 2}\n");
});
it("preserves untouched lines when adding a key inside an existing sequence entry", () => {
  const source = "items:\n  - name: example  # keep\nother:    {x: 1,y: 2}\n";
  expect(add(source, ["items", 0, "enabled"], false)).toBe(source.replace("other:", "    enabled: false\nother:"));
});
it("handles additions at a shared parent/child end offset without changing values", () => {
  const source = "defaults:\n  model: example\n", doc = parseDocument(source, { keepSourceTokens: true });
  doc.setIn(["monitoring", "enabled"], false); doc.setIn(["defaults", "enabled"], false);
  const result = stringifyFleetYaml(doc, source);
  expect(result).toBe(source + "  enabled: false\nmonitoring:\n  enabled: false\n");
});
it("keeps an alias's other value isolated when source splicing would restore the old shared anchor", () => {
  const result = add("first: &shared {enabled: false}\nother: *shared\n", ["first", "extra"], true);
  expect(yaml.load(result)).toEqual({ first: { enabled: false, extra: true }, other: { enabled: false } });
});
it("keeps long values and flow style on the normal existing-value edit path too", () => {
  const source = `value: "${long}"\nsettings: { enabled: false }\n`, doc = parseDocument(source, { keepSourceTokens: true });
  doc.setIn(["settings", "enabled"], true);
  const result = stringifyFleetYaml(doc, source);
  expect(result).toContain(`value: "${long}"\n`);
  expect(result).toContain("settings: { enabled: true }\n");
});

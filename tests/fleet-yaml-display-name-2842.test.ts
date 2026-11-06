/**
 * #2842: set_display_name and set_description write through the real saver (re-read, parseDocument, leaf write on the
 * fresh document), so a key a human added since the last load is replaced in place, never written a second time; and
 * a file a human left with a duplicate key is refused, not overwritten.
 *
 * Isolation: temp dirs; no tmux, no CLI, no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
function fleet(source: string): { dir: string; path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-2842-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source);
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { dir, path, fm };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const keys = (text: string, field: string) => text.match(new RegExp(`^ {4}${field}:`, "gm"))?.length ?? 0;

describe("#2842: an identity field a human added by hand is upserted, never duplicated", () => {
  const BASE = `instances:
  ocean:
    working_directory: /tmp/ocean
    backend: codex
    tags:
      - ocean-king
  other:
    working_directory: /tmp/other
`;
  it.each(["display_name", "description"] as const)("%s: loaded without it, added by hand (no reload), then set by the agent: one key, the agent's value", async field => {
    const { dir, path, fm } = fleet(BASE);
    writeFileSync(path, BASE.replace("      - ocean-king\n", `      - ocean-king\n    ${field}: 觀潮\n`));
    const result = field === "display_name" ? await fm.handleSetDisplayNameHttp("ocean", "Tide") : await fm.handleSetDescriptionHttp("ocean", "Tide");
    expect(result).toEqual({ [field]: "Tide" });
    const after = readFileSync(path, "utf8");
    expect(keys(after, field)).toBe(1);
    expect(after).toContain(`      - ocean-king\n    ${field}: Tide\n  other:`);          // the hand-added key, in its place
    const reloaded = new FleetManager(dir);
    reloaded.loadConfig(path);
    expect(reloaded.fleetConfig!.instances.ocean![field]).toBe("Tide");
  });

  it("a second display_name a human appended (the issue's exact error): the agent's save is refused and the file is left as written", async () => {
    const SET = `instances:
  ocean:
    working_directory: /tmp/ocean
    backend: codex
    display_name: 潮汐
    tags:
      - ocean-king
`;
    const { path, fm } = fleet(SET);
    const edited = `${SET}    display_name: 觀潮\n`;
    writeFileSync(path, edited);
    await expect(fm.handleSetDisplayNameHttp("ocean", "Tide")).rejects.toThrow(/^Refusing to overwrite invalid fleet\.yaml: Map keys must be unique/);
    expect(readFileSync(path, "utf8")).toBe(edited);
    // The next load fails exactly as the issue's fleet.log shows: the second key, under the list.
    expect(() => new FleetManager(fleet("instances: {}\n").dir).loadConfig(path)).toThrow(/Map keys must be unique at line 8, column 5/);
  });
});

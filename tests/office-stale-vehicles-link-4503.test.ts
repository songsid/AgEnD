/**
 * #4505 review: a tab opened before an upgrade keeps the modules it loaded then. The Office fetched afterwards links
 * against the old fleet-office-vehicles.js (tests/fixtures/fleet-office-vehicles-before-4503.js, release e05fb818's,
 * the one before worker seats), so it may import nothing that file lacks — the first version of #4505 imported
 * `workVehicleOf` from it, and the whole Office failed to link ("does not provide an export named 'workVehicleOf'"):
 * no scene at all, old packs and callers included. workVehicleOf now lives in fleet-office.js itself.
 *
 * A real ES module link (V8's linker through vm.SourceTextModule, tests/helpers/esm-link-probe.mjs), as in #3321.
 * With the old module the riders have no `waitingFor`: drawPart reads it only when there is one (tested in
 * web-office-pack-fields-4503: drawn with none).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const probe = join(repo, "tests", "helpers", "esm-link-probe.mjs");
const OLD = join(repo, "tests", "fixtures", "fleet-office-vehicles-before-4503.js");
const oldTab = { "/ui/js/fleet-office-vehicles.js": OLD };

function link(cfg: { root?: string; inline?: string; overrides?: Record<string, string> }): { ok: boolean; modules?: number; message?: string } {
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", probe, JSON.stringify({ repo, ...cfg })], { encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`the link probe printed nothing (status ${r.status}): ${r.stderr}`);
  return JSON.parse(line);
}

describe("an old tab's fleet-office-vehicles.js does not break the Office link (#4505 review)", () => {
  it("the stand-in is what an old tab holds: no worker seats, no workVehicleOf, no waitingFor; and every export it had is still there", () => {
    const old = readFileSync(OLD, "utf8"), now = readFileSync(join(repo, "src/ui/fleet-office-vehicles.js"), "utf8");
    expect(old).not.toMatch(/worker|workVehicleOf|waitingFor/);
    const names = (src: string) => new Set([...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]!));
    expect([...names(old)].filter((n) => !names(now).has(n))).toEqual([]);
  });
  it("current → current: the Office and the share page link (the control)", () => {
    for (const root of ["/ui/js/fleet-office.js", "/ui/js/office-share-page.js"]) {
      const r = link({ root });
      expect(r, root).toMatchObject({ ok: true });
      expect(r.modules, root).toBeGreaterThan(15);
    }
  });
  it("old vehicles module → the new Office and share page still link", () => {
    for (const root of ["/ui/js/fleet-office.js", "/ui/js/office-share-page.js"]) expect(link({ root, overrides: oldTab }), root).toMatchObject({ ok: true });
  });
  it("the probe can fail: importing workVehicleOf from the vehicles module, as the first version did, does not link against the old file", () => {
    const r = link({ inline: `import { workVehicleOf } from "/ui/js/fleet-office-vehicles.js"; export const x = workVehicleOf;`, overrides: oldTab });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not provide an export named 'workVehicleOf'/);
  });
});

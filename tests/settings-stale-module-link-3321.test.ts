/**
 * #3321 review: a tab opened before an upgrade keeps the shared modules it loaded then (the shell loads usage-dialog.js through header-tools.js), and
 * Settings, entered afterwards, fetches the new accounts-view.js against them. A named import of something the old file never exported fails the link
 * of the whole Settings page ("does not provide an export named 'CompactMeter'").
 *
 * This is a real ES module link (V8's linker through vm.SourceTextModule, tests/helpers/esm-link-probe.mjs), not a reading of the source:
 *  - old shell → new Settings: the upstream usage-dialog.js from before the meter had its own module (tests/fixtures/usage-dialog-before-usage-meter.js —
 *    it defines CompactMeter without exporting it) is served at /assets/usage-dialog.js, and the Settings entry and the Accounts view link;
 *  - current → current: the control that links as well;
 *  - the probe can fail: the import the first version of this change made (CompactMeter from usage-dialog.js) does not link against that old file.
 * The meter is in /assets/usage-meter.js, a module a tab has never loaded and so fetches; the Usage panel (usage-dialog.js) keeps exporting what it did.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const probe = join(repo, "tests", "helpers", "esm-link-probe.mjs");
const OLD = join(repo, "tests", "fixtures", "usage-dialog-before-usage-meter.js");
const oldShell = { "/assets/usage-dialog.js": OLD };

function link(cfg: { root?: string; inline?: string; overrides?: Record<string, string> }): { ok: boolean; modules?: number; message?: string } {
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", probe, JSON.stringify({ repo, ...cfg })], { encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`the link probe printed nothing (status ${r.status}): ${r.stderr}`);
  return JSON.parse(line);
}

describe("an old shell's usage-dialog.js does not break the Settings link (#3321 review)", () => {
  it("the stand-in is what an old tab holds: CompactMeter defined, not exported; and the Usage panel's exports are still the same", () => {
    const old = readFileSync(OLD, "utf8");
    expect(old).toMatch(/^function CompactMeter\(/m);
    expect(old).not.toMatch(/export (?:function|const) CompactMeter\b/);
    const now = readFileSync(join(repo, "src/ui/shared/usage-dialog.js"), "utf8");
    // What usage-dialog.js exported before still comes from it, for anything that imports it from there.
    const names = (src: string) => new Set([...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]!));
    const reexported = [...now.matchAll(/^export \{([^}]*)\} from /gm)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
    const missing = [...names(old)].filter((n) => !names(now).has(n) && !reexported.includes(n));
    expect(missing).toEqual([]);
  });

  it("current shell → current Settings: links (the control)", () => {
    const r = link({ root: "/ui/js/panel-settings.js" });
    expect(r).toMatchObject({ ok: true });
    expect(r.modules).toBeGreaterThan(40);
  });

  it("old shell → new Settings: the Settings entry links against the old usage-dialog.js", () => {
    const r = link({ root: "/ui/js/panel-settings.js", overrides: oldShell });
    expect(r).toMatchObject({ ok: true });
    expect(r.modules).toBeGreaterThan(40);
  });

  it("old shell → the Accounts view on its own, and its Keep sign-in alive control, link too", () => {
    expect(link({ root: "/ui/js/accounts-view.js", overrides: oldShell })).toMatchObject({ ok: true });
    expect(link({ root: "/ui/js/accounts-keepalive.js", overrides: oldShell })).toMatchObject({ ok: true });
  });

  it("the probe can fail: importing CompactMeter from usage-dialog.js does not link against the old file, as the first version did", () => {
    const asBefore = `import { CompactMeter } from "/assets/usage-dialog.js"; export const x = CompactMeter;`;
    const r = link({ inline: asBefore, overrides: oldShell });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not provide an export named 'CompactMeter'/);
  });

  it("the meter's own module has everything the new Settings imports from it, and the Usage panel draws the same meter", () => {
    expect(link({ inline: `import { CompactMeter } from "/assets/usage-meter.js"; export const x = CompactMeter;` })).toMatchObject({ ok: true });
    const dialog = readFileSync(join(repo, "src/ui/shared/usage-dialog.js"), "utf8");
    expect(dialog).toMatch(/from "\.\/usage-meter\.js"/);
    expect(dialog).not.toMatch(/function CompactMeter\b/);                       // one meter, not a second
    const view = readFileSync(join(repo, "src/ui/accounts-view.js"), "utf8");
    expect(view).toMatch(/import \{ CompactMeter \} from "\/assets\/usage-meter\.js"/);
    expect(view).not.toMatch(/from "\/assets\/usage-dialog\.js"/);
  });

  it("usage-meter.js is served wherever usage-dialog.js is (the app's assets and the public share page's)", () => {
    for (const f of ["src/auth-api.ts", "src/office-share-page.ts"]) {
      const src = readFileSync(join(repo, f), "utf8");
      expect(src, f).toContain('"usage-dialog.js"');
      expect(src, f).toContain('"usage-meter.js"');
    }
  });
});

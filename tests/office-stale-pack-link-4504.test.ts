/**
 * #4508 (after the #4505 review's finding): a tab opened before an upgrade keeps the fleet-office-pack.js it loaded.
 * The Office fetched afterwards links against it, so it may import nothing that file lacks. The first version of #4508
 * imported PREVIEW_POSES and previewLook from it; they now live in fleet-office.js, their one consumer.
 *
 * A real ES module link (tests/helpers/esm-link-probe.mjs, as in #3321). The stand-in
 * (tests/fixtures/fleet-office-pack-exports-before-4504.js) is release e05fb818's export names, each a stub — the
 * linker checks names only, so it is what an old tab's module offers.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const probe = join(repo, "tests", "helpers", "esm-link-probe.mjs");
const OLD = join(repo, "tests", "fixtures", "fleet-office-pack-exports-before-4504.js");
const oldTab = { "/ui/js/fleet-office-pack.js": OLD };

function link(cfg: { root?: string; inline?: string; overrides?: Record<string, string> }): { ok: boolean; modules?: number; message?: string } {
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", probe, JSON.stringify({ repo, ...cfg })], { encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`the link probe printed nothing (status ${r.status}): ${r.stderr}`);
  return JSON.parse(line);
}

describe("an old tab's fleet-office-pack.js does not break the Office link (#4508)", () => {
  it("the stand-in has no preview helpers, and the pack module still exports every name it lists", () => {
    const old = readFileSync(OLD, "utf8"), now = readFileSync(join(repo, "src/ui/fleet-office-pack.js"), "utf8");
    expect(old).not.toMatch(/PREVIEW_POSES|previewLook/);
    const names = (src: string) => new Set([...src.matchAll(/^export (?:async )?(?:function\*?|const|let|class) (\w+)/gm)].map((m) => m[1]!));
    expect(names(old).size).toBeGreaterThan(40);
    expect([...names(old)].filter((n) => !names(now).has(n))).toEqual([]);
  });
  it("current → current, and old pack module → the new Office, card and share page: all link", () => {
    for (const root of ["/ui/js/fleet-office.js", "/ui/js/fleet-office-card.js", "/ui/js/office-share-page.js"]) {
      expect(link({ root }), root).toMatchObject({ ok: true });
      expect(link({ root, overrides: oldTab }), `${root} (old pack)`).toMatchObject({ ok: true });
    }
  });
  it("the probe can fail: importing previewLook from the pack module, as the first version did, does not link against it", () => {
    const r = link({ inline: `import { previewLook } from "/ui/js/fleet-office-pack.js"; export const x = previewLook;`, overrides: oldTab });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not provide an export named 'previewLook'/);
  });
});

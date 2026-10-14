/**
 * #1819: CI installs the published @songsid/agend 2.1.12 from one cached tarball, not from the registry by name — every
 * registry fetch of our tarball counts as an npm download. The tarball is checked against the registry's dist.integrity
 * before each use (fails closed), and the install itself fails if npm fetched an @songsid/agend tarball anyway.
 * The real scripts run here with an inert npm stub (no registry, no install).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const VERIFY = join(ROOT, "scripts", "ci", "verify-published-tarball.sh");
const INSTALL = join(ROOT, "scripts", "ci", "install-published-tarball.sh");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A scratch dir with a fake tarball and an npm stub whose body is `npmBody` (it logs its argv to `calls`). */
function rig(npmBody: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-1819-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tgz = join(root, "songsid-agend-2.1.12.tgz");
  writeFileSync(tgz, "the published bytes");
  const calls = join(root, "calls");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${calls}'\n${npmBody}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const run = (script: string, args: string[]) => {
    const r = spawnSync("bash", [script, ...args], {
      encoding: "utf8", timeout: 30_000,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
    });
    return { status: r.status, out: r.stdout + r.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
  };
  return { root, tgz, run };
}
const integrityOf = (bytes: string) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

describe("verify-published-tarball.sh: the tarball is exactly what the registry published, or nothing installs", () => {
  const verify = (viewBody: string) => {
    const r = rig(viewBody);
    return { ...r.run(VERIFY, [r.tgz, "@songsid/agend", "2.1.12"]), tgz: r.tgz };
  };
  it("control: sha512 equals the registry's dist.integrity → verified, from a metadata request only", () => {
    const r = verify(`echo '${integrityOf("the published bytes")}'`);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`verified: ${r.tgz} is the published @songsid/agend@2.1.12`);
    expect(r.calls).toEqual(["npm view @songsid/agend@2.1.12 dist.integrity --registry https://registry.npmjs.org/"]);
  });
  it("a tampered or stale tarball (another sha512) fails closed", () => {
    const r = verify(`echo '${integrityOf("other bytes")}'`);
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not the published @songsid/agend@2.1.12: its sha512 is");
  });
  it.each([
    ["the registry is unreachable", "exit 1", "could not read the registry's dist.integrity"],
    ["the version is unknown (empty output)", "exit 0", "the registry gave no sha512 integrity"],
    ["only a sha1 integrity", "echo sha1-abc", "the registry gave no sha512 integrity"],
  ])("%s → fails closed", (_case, body, reason) => {
    const r = verify(body);
    expect(r.status).toBe(1);
    expect(r.out).toContain(reason);
  });
  it("no tarball → fails before asking the registry", () => {
    const r = rig(`echo '${integrityOf("the published bytes")}'`);
    const out = r.run(VERIFY, [join(r.root, "missing.tgz"), "@songsid/agend", "2.1.12"]);
    expect(out.status).toBe(1);
    expect(out.out).toContain("no tarball at");
    expect(out.calls).toEqual([]);
  });
});

describe("install-published-tarball.sh: the install downloads no @songsid/agend tarball", () => {
  const DEP = "npm http fetch GET 200 https://registry.npmjs.org/ejs/-/ejs-5.0.1.tgz 40ms (cache miss)";
  const install = (log: string[], rc = 0) => {
    const r = rig(`cat <<'LOG' >&2\n${log.join("\n")}\nLOG\nexit ${rc}`);
    return { ...r.run(INSTALL, ["@songsid/agend", r.tgz, "--prefix", join(r.root, "prefix")]), tgz: r.tgz, root: r.root };
  };
  it("control: only dependency requests (and a metadata fetch, and a tarball served from npm's cache) → installed, counted", () => {
    const r = install([
      DEP,
      "npm http fetch GET 200 https://registry.npmjs.org/@songsid%2fagend 180ms (cache miss)",
      "npm http cache @songsid/agend@https://registry.npmjs.org/@songsid/agend/-/agend-2.1.12.tgz 0ms (cache hit)",
      "added 120 packages in 3s",
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("added 120 packages in 3s");
    expect(r.out).toContain(`installed @songsid/agend from ${r.tgz}: 2 registry requests (dependencies), none for a @songsid/agend tarball`);
    expect(r.calls).toEqual([`npm install --global --no-audit --no-fund --loglevel=http --prefix ${join(r.root, "prefix")} ${r.tgz}`]);
  });
  it.each([
    ["by path", "npm http fetch GET 200 https://registry.npmjs.org/@songsid/agend/-/agend-2.1.12.tgz 42ms (cache miss)"],
    ["encoded scope", "npm http fetch GET 200 https://registry.npmjs.org/@songsid%2Fagend/-/agend-2.1.12.tgz 42ms"],
    ["from a mirror", "npm http fetch GET 200 http://127.0.0.1:4873/@songsid/agend/-/agend-2.1.12.tgz 9ms"],
  ])("a fetch of an @songsid/agend tarball (%s) fails the step", (_case, line) => {
    const r = install([DEP, line]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(line);
    expect(r.out).toContain("downloaded a @songsid/agend tarball from a registry");
  });
  it("another package whose name merely starts the same (@songsid/agend-node-…) is a dependency, not ours", () => {
    const r = install([DEP, "npm http fetch GET 200 https://registry.npmjs.org/@songsid/agend-node-linux-x64/-/agend-node-linux-x64-22.23.3.tgz 9ms"]);
    expect(r.status).toBe(0);
  });
  it("npm fails → the step fails with npm's reason shown", () => {
    const r = install(["npm error code EACCES"], 1);
    expect(r.status).toBe(1);
    expect(r.out).toContain("npm error code EACCES");
    expect(r.out).toContain("exited 1");
  });
  it("no tarball → fails without running npm", () => {
    const r = rig("exit 0");
    const out = r.run(INSTALL, ["@songsid/agend", join(r.root, "missing.tgz")]);
    expect(out.status).toBe(1);
    expect(out.calls).toEqual([]);
  });
});

describe("no workflow fetches the published package from the registry by name", () => {
  const files = (dir: string, ext: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []);
  const sources = [...files(join(ROOT, ".github"), /\.ya?ml$/), ...files(join(ROOT, "scripts", "ci"), /\.(sh|mjs|cjs)$/)];

  it("every npm install/pack of @songsid/agend by name: the action's one fetch on a cache miss, and the candidate from the local registry", () => {
    // Commands only: comments and `step "…"` banners describe them.
    const byName = /\bnpm\s+(install|i|add|pack)\b.*@songsid\/agend@/;
    const hits = sources.flatMap(f => readFileSync(f, "utf8").split("\n")
      .filter(l => byName.test(l) && !/^\s*#/.test(l) && !/^\s*step "/.test(l))
      .map(l => `${f.slice(ROOT.length + 1)}: ${l.trim()}`));
    expect(hits.sort()).toEqual([
      '.github/actions/published-agend-tarball/action.yml: npm pack "@songsid/agend@$VERSION" --pack-destination "$dir" --registry https://registry.npmjs.org/',
      'scripts/ci/runtime-acceptance/hop.sh: npm install -g --no-audit --no-fund "@songsid/agend@$CAND"',
      'scripts/ci/runtime-acceptance/install-run.sh: npm install -g --no-audit --no-fund "@songsid/agend@$CAND"',
    ]);
    const action = yaml.load(readFileSync(join(ROOT, ".github/actions/published-agend-tarball/action.yml"), "utf8")) as {
      runs: { steps: Array<{ id?: string; if?: string; run?: string; uses?: string; with?: Record<string, string> }> };
    };
    const steps = action.runs.steps;
    const fetch = steps.find(s => s.run?.includes("npm pack"))!;
    expect(fetch.if).toBe("steps.restore.outputs.cache-hit != 'true'");
    // Order: restore, fetch on a miss, verify (always), save only on a miss and only after verify passed.
    expect(steps.map(s => s.id ?? s.uses ?? "fetch")).toEqual(["restore", "fetch", "verify", "actions/cache/save@v4"]);
    expect(steps[2].if).toBeUndefined();
    expect(steps[3].if).toBe("steps.restore.outputs.cache-hit != 'true'");
    expect(steps[0].with!.key).toBe(steps[3].with!.key);
    expect(steps[0].with!.path).toBe(steps[3].with!.path);
  });

  it("a workflow that filters pull requests by path runs when a helper it installs through changes (#1821 review)", () => {
    const helpers = [
      ".github/actions/published-agend-tarball/action.yml",
      "scripts/ci/install-published-tarball.sh",
      "scripts/ci/verify-published-tarball.sh",
    ];
    // GitHub's filter globs as these workflows use them: a literal path, or a directory prefix ending in /**.
    const covers = (pattern: string, file: string) => pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : pattern === file;
    const filtered = files(join(ROOT, ".github", "workflows"), /\.ya?ml$/).flatMap(f => {
      const text = readFileSync(f, "utf8");
      if (!text.includes("./.github/actions/published-agend-tarball")) return [];
      const on = (yaml.load(text) as { on: { pull_request?: { paths?: string[] } | null } }).on;
      const paths = on.pull_request?.paths;
      return paths ? [{ file: f.slice(ROOT.length + 1), paths }] : [];
    });
    expect(filtered.map(w => w.file)).toEqual([".github/workflows/runtime-acceptance.yml"]);
    for (const w of filtered) {
      expect(helpers.filter(h => !w.paths.some(p => covers(p, h))), w.file).toEqual([]);
    }
  });

  it.each([
    ["ci.yml", "node20-rollback-smoke", "baseline-tarball", "BASELINE_TGZ"],
    ["data-downgrade.yml", "data-downgrade", "baseline-tarball", "BASELINE_TGZ"],
    ["runtime-acceptance.yml", "hop", "old-tarball", "AGEND_OLD_TARBALL"],
    ["mac-gui-rehearsal.yml", "gui", "old-tarball", "AGEND_OLD_TARBALL"],
  ])("%s %s: the cached 2.1.12 tarball feeds the step that installs it", (file, job, id, envName) => {
    const wf = yaml.load(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as {
      jobs: Record<string, { steps: Array<{ id?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }> }>;
    };
    const steps = wf.jobs[job].steps;
    const at = steps.findIndex(s => s.id === id);
    expect(steps[at].uses).toBe("./.github/actions/published-agend-tarball");
    expect(String(steps[at].with!.version)).toBe("2.1.12");
    const consumer = steps.findIndex(s => s.env?.[envName] === `\${{ steps.${id}.outputs.tarball }}`);
    expect(consumer).toBeGreaterThan(at);
    // The docs-only guard of ci.yml's rollback job covers the fetch too: a docs-only head downloads nothing.
    expect(steps[at].if).toBe(steps[consumer].if);
  });
});

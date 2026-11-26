/**
 * M-3805: npm 12 runs a package's install scripts only when `allow-scripts` names it. A plain `npm install -g
 * @songsid/agend` then skipped launcher/postinstall.cjs, the bundled Node was never verified, and AgEnD refused to start
 * with "missing, incomplete or changed since it was verified" and a repair line that failed the same way.
 *
 * Here: the shared helper; the launcher (JS and sh) naming the cause and printing the command that works on npm 12;
 * `agend update`'s environment (the variable reaches the release's own installer through `npm exec`, a flag does not);
 * the installer stripping it before the fleet restarts; install.sh's installer step. The real-npm-12 reproduction is
 * scripts/manual/npm12-allow-scripts-m3805/repro.sh (evidence in docs/evidence/npm12-allow-scripts-m3805/).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyUpdateAllowScripts, applyUpdateNpmBounds, dropUpdateNpmBounds, parseNpmConfigLs, scriptsIgnoredStop, updateScriptsIgnored, withoutUpdateNpmBounds } from "../src/update-npm-env.js";

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, "..");
const allow = require("../launcher/npm-allow-scripts.cjs") as {
  PACKAGE: string; FLAG: string; ENV: string; flagFor(spec: string): string; installCommand(spec?: string): string;
  names(v: unknown): string[]; covers(v: unknown): boolean; withPackage(v: unknown): string; scriptsIgnored(v: unknown): boolean;
};
const platform = require("../launcher/runtime-platform.cjs");
const select = require("../launcher/runtime-select.cjs");
const installer = require("../launcher/agend-install.cjs") as { withoutUpdateNpmBounds(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv };
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };

describe("the shared helper", () => {
  it("the flag and the command a person runs", () => {
    expect(allow.FLAG).toBe("--allow-scripts=@songsid/agend");
    expect(allow.ENV).toBe("npm_config_allow_scripts");
    expect(allow.installCommand("@songsid/agend@2.4.0")).toBe("npm install -g --allow-scripts=@songsid/agend @songsid/agend@2.4.0");
    expect(allow.installCommand()).toBe("npm install -g --allow-scripts=@songsid/agend @songsid/agend");
  });

  it("a registry spec is allowed by name; a tarball or folder only by its absolute path (npm 12 matches it so)", () => {
    expect(allow.flagFor("@songsid/agend@2.4.0-beta.24")).toBe(allow.FLAG);
    expect(allow.flagFor("/tmp/x/songsid-agend-2.4.0.tgz")).toBe("--allow-scripts=/tmp/x/songsid-agend-2.4.0.tgz");
    expect(allow.flagFor("file:/tmp/pkg")).toBe("--allow-scripts=/tmp/pkg");
    expect(allow.flagFor("./songsid-agend-2.4.0.tgz")).toBe(`--allow-scripts=${join(process.cwd(), "songsid-agend-2.4.0.tgz")}`);
    expect(allow.flagFor("~/dl/songsid-agend-2.4.0.tgz")).toBe(`--allow-scripts=${join(homedir(), "dl", "songsid-agend-2.4.0.tgz")}`);
  });

  it("reads both shapes of the list: comma text and the JSON list `npm config ls` prints", () => {
    expect(allow.names('["bar","baz"]')).toEqual(["bar", "baz"]);
    expect(allow.names(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(allow.covers("x,@songsid/agend")).toBe(true);
    expect(allow.covers('["@songsid/agend@*"]')).toBe(true);
    expect(allow.covers("@songsid/agend@2.4.0")).toBe(false);          // one pinned version is not every version
    expect(allow.covers("@songsid/agend-node-linux-x64")).toBe(false);
    expect(allow.withPackage('["bar"]')).toBe("bar,@songsid/agend");
    expect(allow.withPackage(undefined)).toBe("@songsid/agend");
    expect(allow.withPackage("@songsid/agend,x")).toBe("@songsid/agend,x");
  });

  it("ignore-scripts read as npm reads a boolean given as text", () => {
    for (const on of [true, "true", "1", "yes", "on"]) expect(allow.scriptsIgnored(on)).toBe(true);
    for (const off of [undefined, null, false, "false", "0", "", "null"]) expect(allow.scriptsIgnored(off)).toBe(false);
  });
});

// The fixture host: linux-x64 with this machine's glibc (supported), as the launcher sees it.
const HOST = { platform: "linux", arch: "x64", id: "linux-x64", glibc: platform.glibcVersion() ?? "2.35", darwinRelease: null };
const NOW = { node: "22.20.0", napi: 10 };

/** A package as npm 12 leaves it: the bundled Node's package installed, its install step (receipt, key) never run. */
function skippedInstall(opts: { runtime?: "file" | "dangling"; receipt?: boolean } = {}) {
  const root = scratch("agend m3805-");
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  cpSync(join(REPO, "launcher"), join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.4.0", engines: { node: "^22.14.0 || ^23.6.0 || >=24" },
    optionalDependencies: { [`@songsid/agend-node-${HOST.id}`]: process.versions.node } }, null, 2) + "\n");
  const runtime = join(pkg, "node_modules", "@songsid", `agend-node-${HOST.id}`);
  if ((opts.runtime ?? "file") === "file") {
    mkdirSync(join(runtime, "bin"), { recursive: true });
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: `@songsid/agend-node-${HOST.id}`, version: process.versions.node }, null, 2) + "\n");
    writeFileSync(join(runtime, "bin", "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(join(runtime, "bin", "node"), 0o755);
  } else {
    mkdirSync(join(pkg, "node_modules", "@songsid"), { recursive: true });
    symlinkSync(join(root, "nowhere"), runtime);
  }
  if (opts.receipt) writeFileSync(join(pkg, ".agend-runtime.json"), "{}\n");
  return { root, pkg, launcherDir: join(pkg, "launcher") };
}
const choose = (f: ReturnType<typeof skippedInstall>) => select.selectRuntime(f.launcherDir, { env: {}, host: HOST, versions: NOW });
const FIX = "npm install -g --allow-scripts=@songsid/agend @songsid/agend@2.4.0";

describe("the launcher names the cause and the command that works on npm 12", () => {
  it("runtime installed, install step never ran: says so, and the repair allows the scripts", () => {
    const r = choose(skippedInstall());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("AgEnD's install step did not run, so its bundled Node");
    expect(r.reason).toContain("npm 12 skips a package's install scripts unless they are allowed");
    expect(r.reason).not.toContain("changed since it was verified");
    expect(r.recovery).toBe(FIX);
  });

  it("a receipt that is there, or a runtime that is only a dangling link, is not this case: the old reason, the new repair", () => {
    for (const f of [skippedInstall({ receipt: true }), skippedInstall({ runtime: "dangling" })]) {
      const r = choose(f);
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("missing, incomplete or changed since it was verified"), recovery: FIX });
    }
  });

  it("the JS launcher prints both lines (what the user saw, now with the cause and the working command)", () => {
    const f = skippedInstall();
    const r = spawnSync(process.execPath, [join(f.launcherDir, "agend.cjs"), "--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AGEND_NODE: "" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AgEnD cannot start: AgEnD's install step did not run, .*npm 12 skips/);
    expect(r.stderr).toContain(`To repair: ${FIX}`);
  });

  /** A PATH with only the tools the sh bin uses: no node on it. */
  const toolsOnly = () => {
    const d = scratch("agend tools-");
    for (const tool of ["sh", "readlink", "dirname", "basename", "uname", "wc", "tr", "stat", "cksum", "cmp", "getconf"]) {
      symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(d, tool));
    }
    return d;
  };

  it("the sh bin with no node on PATH says the install step did not run, and prints the npm 12 command", () => {
    const f = skippedInstall();
    const r = spawnSync(join(f.launcherDir, "agend"), ["--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: toolsOnly(), AGEND_NODE: "" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AgEnD cannot start: its install step did not run, so its bundled Node was never verified (npm 12 skips install scripts unless they are allowed), and there is no node on PATH.");
    expect(r.stderr).toContain("To repair: npm install -g --allow-scripts=@songsid/agend @songsid/agend");
  });

  it("Fable N3: a dangling receipt link is not 'absent' for the sh bin either: it agrees with the JS (the changed-runtime refusal)", () => {
    const f = skippedInstall();
    symlinkSync(join(f.root, "no-receipt"), join(f.pkg, ".agend-runtime.json"));
    expect(choose(f).reason).toContain("missing, incomplete or changed since it was verified");
    const r = spawnSync(join(f.launcherDir, "agend"), ["--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: toolsOnly(), AGEND_NODE: "" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is missing, incomplete or changed since it was verified, and there is no node on PATH");
    expect(r.stderr).not.toContain("install step did not run");
  });

  it("every repair line the launcher, postinstall and preinstall print allows the scripts", () => {
    for (const file of ["launcher/runtime-select.cjs", "launcher/postinstall.cjs", "launcher/agend", "launcher/agend-agent", "scripts/preinstall-guard.cjs", "launcher/agend-install.cjs"]) {
      const text = readFileSync(join(REPO, file), "utf8").split("\n").filter(l => !/^\s*(?:\/\/|\*|#)/.test(l)).join("\n");
      expect(text, file).not.toMatch(/"npm install -g @songsid\/agend|npm install -g @songsid\/agend"/);
    }
  });
});

describe("agend update: npm 12 runs AgEnD's install scripts, also through the release's own installer", () => {
  it("nobody set allow-scripts: the update allows exactly AgEnD, and marks it as the update's own", () => {
    const env: NodeJS.ProcessEnv = {};
    applyUpdateNpmBounds(env, new Map());
    expect(applyUpdateAllowScripts(env, new Map())).toBe(true);
    expect(env.npm_config_allow_scripts).toBe("@songsid/agend");
    expect(env.AGEND_UPDATE_NPM_BOUNDS!.split(",")).toEqual(["fetch-timeout", "fetch-retries", "fetch-retry-mintimeout", "fetch-retry-maxtimeout", "allow-scripts"]);
    // What outlives the update (the restarted fleet, its later npm runs) gets the person's own settings back.
    const after = withoutUpdateNpmBounds(env);
    expect(after.npm_config_allow_scripts).toBeUndefined();
    expect(after.AGEND_UPDATE_NPM_BOUNDS).toBeUndefined();
    // The release's installer strips it the same way before it restarts the fleet.
    expect(installer.withoutUpdateNpmBounds(env).npm_config_allow_scripts).toBeUndefined();
  });

  it("what the person allows in .npmrc stays allowed; a list that already covers AgEnD is left alone", () => {
    const env: NodeJS.ProcessEnv = {};
    applyUpdateAllowScripts(env, parseNpmConfigLs('; "user" config from ~/.npmrc\n\nallow-scripts = ["canvas"]\n'));
    expect(env.npm_config_allow_scripts).toBe("canvas,@songsid/agend");
    const covered: NodeJS.ProcessEnv = {};
    expect(applyUpdateAllowScripts(covered, parseNpmConfigLs('allow-scripts = ["@songsid/agend"]\n'))).toBe(false);
    expect(covered).toEqual({});
  });

  it("a variable the person set is theirs: kept as it is, never marked or dropped", () => {
    const env: NodeJS.ProcessEnv = { npm_config_allow_scripts: "canvas" };
    expect(applyUpdateAllowScripts(env, null)).toBe(false);
    expect(env).toEqual({ npm_config_allow_scripts: "canvas" });
    dropUpdateNpmBounds(env);
    expect(env.npm_config_allow_scripts).toBe("canvas");
  });

  it("ignore-scripts on (any npm): the update stops before anything changes, and says how to turn it off", () => {
    expect(updateScriptsIgnored({}, parseNpmConfigLs("ignore-scripts = true\n"))).toBe(true);
    expect(updateScriptsIgnored({}, parseNpmConfigLs('; "env" config from environment\nignore-scripts = "yes"\n'))).toBe(true);
    expect(updateScriptsIgnored({}, parseNpmConfigLs("registry = \"https://registry.npmjs.org/\"\n"))).toBe(false);
    expect(updateScriptsIgnored({ npm_config_ignore_scripts: "true" }, null)).toBe(true);   // npm could not be asked
    expect(updateScriptsIgnored({}, null)).toBe(false);
    expect(scriptsIgnoredStop()).toContain("npm config delete ignore-scripts");
  });

  it("agend update wires it in: the ignore-scripts stop first, then the bounds and the allow list on every npm it starts", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const at = (s: string) => { const i = cli.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("if (updateScriptsIgnored(process.env, explicit))")).toBeLessThan(at("applyUpdateNpmBounds(process.env, explicit);"));
    expect(at("applyUpdateNpmBounds(process.env, explicit);")).toBeLessThan(at("applyUpdateAllowScripts(process.env, explicit);"));
    expect(at("applyUpdateAllowScripts(process.env, explicit);")).toBeLessThan(at('spawnSync("npm", ["exec", "--yes", "--package", pkg'));
  });

  it("through real `npm exec`: the variable reaches the program it starts (a flag would not on npm 11/12)", () => {
    const d = scratch("agend-m3805-exec-");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "m3805-probe", version: "1.0.0", bin: { "m3805-probe": "probe.js" } }));
    writeFileSync(join(d, "probe.js"), "#!/usr/bin/env node\nconsole.log('child:' + process.env.npm_config_allow_scripts);\n");
    chmodSync(join(d, "probe.js"), 0o755);
    const r = spawnSync("npm", ["exec", "--yes", "--package", d, "--", "m3805-probe"], { encoding: "utf8", timeout: 120_000,
      env: { ...process.env, npm_config_cache: join(d, "cache"), npm_config_update_notifier: "false", npm_config_allow_scripts: "@songsid/agend" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("child:@songsid/agend");
  });
});

describe("install.sh: the installer step allows AgEnD's scripts on npm 12", () => {
  const script = readFileSync(join(REPO, "install.sh"), "utf8");
  const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
  const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");

  /** A stub npm that logs each call with what npm 12 would read: its argv and the allow-scripts variables. */
  function host(withInstaller: boolean) {
    const d = scratch("agend-m3805-sh-");
    symlinkSync(process.execPath, join(d, "node"));
    writeFileSync(join(d, "npm"), `#!/bin/sh
echo "npm $* | allow=\${npm_config_allow_scripts-<unset>} | ALLOW=\${NPM_CONFIG_ALLOW_SCRIPTS-<unset>} | mark=\${AGEND_UPDATE_NPM_BOUNDS-<unset>}" >> '${join(d, "npm.log")}'
# As npm answers: the person's variable (either case) wins over their .npmrc ($NPMRC_ALLOW here); unset prints nothing.
[ "$1 $2 $3" = "config get allow-scripts" ] && { echo "\${npm_config_allow_scripts:-\${NPM_CONFIG_ALLOW_SCRIPTS:-\${NPMRC_ALLOW:-}}}"; exit 0; }
case "$1" in
  view) ${withInstaller ? `echo '{"agend":"launcher/agend","agend-install":"launcher/agend-install.cjs"}'` : `echo '{"agend":"launcher/agend"}'`} ;;
  exec|install) exit 0 ;;
  *) exit 9 ;;
esac
`);
    chmodSync(join(d, "npm"), 0o755);
    const run = (env: Record<string, string> = {}) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
      encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: "beta", ...env },
    });
    const log = () => readFileSync(join(d, "npm.log"), "utf8").trim().split("\n");
    return { run, log };
  }

  it("the release's installer is started with the variable (it inherits it, as does its npm install -g), marked as the installer's", () => {
    const h = host(true);
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(h.log().find(l => l.startsWith("npm exec"))).toBe("npm exec --yes --package @songsid/agend@beta -- agend-install | allow=@songsid/agend | ALLOW=<unset> | mark=allow-scripts");
    expect(h.log().find(l => l.startsWith("npm view"))).toContain("allow=<unset>");                // only the install step gets it
  });

  it("a person's own variable is kept and AgEnD added; it is not marked, so it is never dropped", () => {
    const h = host(true);
    expect(h.run({ npm_config_allow_scripts: "canvas" }).status).toBe(0);
    expect(h.log().find(l => l.startsWith("npm exec"))).toMatch(/\| allow=canvas,@songsid\/agend \| ALLOW=<unset> \| mark=$/);
  });

  it("Fable N1: what .npmrc allows is carried too (the variable is a superset, never a replacement), and marked as ours", () => {
    const h = host(true);
    expect(h.run({ NPMRC_ALLOW: "canvas,sharp" }).status).toBe(0);
    expect(h.log().find(l => l.startsWith("npm exec"))).toMatch(/\| allow=canvas,sharp,@songsid\/agend \| ALLOW=<unset> \| mark=allow-scripts$/);
  });

  it("Fable N2: a person's uppercase variable gets the same value, so npm reads one list whichever it picks", () => {
    const h = host(true);
    expect(h.run({ NPM_CONFIG_ALLOW_SCRIPTS: "canvas" }).status).toBe(0);
    expect(h.log().find(l => l.startsWith("npm exec"))).toMatch(/\| allow=canvas,@songsid\/agend \| ALLOW=canvas,@songsid\/agend \| mark=$/);
  });

  it("a release from before the installer: its plain npm install -g passes the flag", () => {
    const h = host(false);
    expect(h.run().status).toBe(0);
    expect(h.log().find(l => l.startsWith("npm install"))).toMatch(/^npm install -g @songsid\/agend@beta --allow-scripts=@songsid\/agend \|/);
  });

  it("the website copy is the same file", () => {
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });
});

/**
 * M-3806: npm 11 and 12 redact UUID-like text in everything they print. For a global prefix whose path contains a UUID,
 * `npm prefix -g` and `npm root -g` print `***` in its place, and `npm config get prefix` refuses ("The prefix option is
 * protected", npm 10 too). The installer then checked, locked or created a folder that doesn't exist; install.sh fell
 * back to /usr/local. A program npm starts still gets the real path in `npm_config_global_prefix`, so a redacted
 * answer is asked again that way: from the filesystem root, because inside a project npm runs the project's own
 * node_modules/.bin/node (Fable #4526 F2), and taken only if npm, redacting it, prints exactly what it printed.
 *
 * Here: the shared helper; real `npm exec` handing the prefix to a child, and a project's `node` shim answering from
 * inside the project; install.sh's prefix/sudo step; chat `/update`'s npm lookup; the CLI's sudo check. The installer
 * and the update's compat path are covered next to their own rigs (agend-install-2264, update-install-1446). The
 * real-npm-10/11/12 reproduction is in docs/evidence/npm-masked-prefix-m3806/.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { npmForRunningInstall, type DispatchDeps } from "../src/update-dispatch.js";

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, "..");
const g = require("../launcher/npm-global-prefix.cjs") as {
  MASK: string; PRINT: string; ASK: string[]; masked(t: unknown): boolean; redact(t: string): string; neutralCwd(): string; lastLine(t: unknown): string;
  confirmed(seen: string, real: string, platform?: string): string;
  rootOf(prefix: string, platform?: string): string; resolve(p: string, r: string | undefined, ask: () => string, platform?: string): { prefix: string; root?: string };
};
const roots: string[] = [];
afterAll(() => { for (const r of roots) { try { chmodSync(r, 0o755); } catch { /* gone */ } rmSync(r, { recursive: true, force: true }); } });
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };
const UUID = "0b7e5a2c-3f1d-4c6e-9a8b-1234567890ab";
const redact = (text: string) => g.redact(text);
/** A project folder with its own `node` in node_modules/.bin (what the npm package `node` installs), printing `answer`. */
function projectWithNodeShim(answer: string): string {
  const d = scratch("agend-m3806-project-");
  mkdirSync(join(d, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "some-project", version: "1.0.0" }));
  writeFileSync(join(d, "node_modules", ".bin", "node"), `#!/bin/sh\necho ${JSON.stringify(answer)}\n`);
  chmodSync(join(d, "node_modules", ".bin", "node"), 0o755);
  return d;
}

describe("the shared helper", () => {
  it("tells a redacted answer, redacts as npm does, takes npm's last line, and lays out the root as npm does", () => {
    expect(g.masked("/home/u/pfx-***")).toBe(true);
    expect(g.masked("/home/u/.npm-global")).toBe(false);
    expect(g.masked(undefined)).toBe(false);
    expect(redact(`/home/u/pfx-${UUID}/x-${UUID.toUpperCase()}`)).toBe("/home/u/pfx-***/x-***");
    expect(redact(`/home/u/a${UUID}`), "npm's matcher needs a word boundary").toBe(`/home/u/a${UUID}`);
    expect(g.lastLine("npm warn x\n/home/u/p\n\n")).toBe("/home/u/p");
    expect(g.lastLine("")).toBe("");
    expect(g.rootOf("/home/u/p", "linux")).toBe("/home/u/p/lib/node_modules");
    expect(g.rootOf("/home/u/p", "darwin")).toBe("/home/u/p/lib/node_modules");
    expect(g.rootOf("C:\\Users\\u\\AppData\\Roaming\\npm", "win32")).toBe("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules");
    expect(g.ASK).toEqual(["exec", "-c", "node -p process.env.npm_config_global_prefix"]);
    expect(g.neutralCwd()).toBe(parse(process.cwd()).root);
  });

  it("an unredacted answer is used as npm gave it, and npm is not asked again", () => {
    let asked = 0;
    const ask = () => { asked += 1; return "/elsewhere\n"; };
    expect(g.resolve("/home/u/p\n", "/home/u/p/lib/node_modules\n", ask, "linux")).toEqual({ prefix: "/home/u/p", root: "/home/u/p/lib/node_modules" });
    expect(g.resolve("/home/u/p\n", undefined, ask)).toEqual({ prefix: "/home/u/p" });
    expect(g.resolve("", undefined, ask), "no answer is not asked for: the caller says npm did not say").toEqual({ prefix: "" });
    expect(asked).toBe(0);
  });

  it("a redacted answer: the prefix as a child sees it, and the root under that prefix", () => {
    const real = `/home/u/pfx-${UUID}`;
    let asked = 0;
    const ask = () => { asked += 1; return `npm notice run x\n${real}\n`; };
    expect(g.resolve(redact(real), redact(`${real}/lib/node_modules`), ask, "linux")).toEqual({ prefix: real, root: `${real}/lib/node_modules` });
    expect(g.resolve(redact(real), undefined, ask)).toEqual({ prefix: real });
    expect(asked).toBe(2);
  });

  it("an answer npm would not have printed that way is not taken: another path, another folder name, a relative path (Fable #4526 F2)", () => {
    const real = `/home/u/pfx-${UUID}`;
    const seen = redact(real);
    for (const other of ["/from-project-local-node", `/home/u/pfx-${UUID}/extra`, `/home/v/pfx-${UUID}`, "/home/u/pfx-not-a-uuid", `home/u/pfx-${UUID}`, `/home/u/pfx-a${UUID}`]) {
      expect(g.confirmed(seen, other), other).toBe("");
      expect(g.resolve(seen, `${seen}/lib/node_modules`, () => `${other}\n`, "linux"), other).toEqual({ prefix: "", root: "" });
    }
    expect(g.confirmed("pfx-***", `pfx-${UUID}`), "a relative path is never a prefix").toBe("");
    expect(g.confirmed(seen, `/home/u/pfx-${UUID.toUpperCase()}`), "npm's matcher ignores case").toBe(`/home/u/pfx-${UUID.toUpperCase()}`);
    // A root npm printed elsewhere than the prefix's own layout: not taken either.
    expect(g.resolve(seen, redact(`/other/${UUID}/lib/node_modules`), () => `${real}\n`, "linux")).toEqual({ prefix: "", root: "" });
  });

  it("no usable second answer (failed, empty, still redacted, `undefined`): nothing, never the redacted path", () => {
    const masked = redact(`/home/u/pfx-${UUID}`);
    for (const ask of [() => { throw new Error("spawn failed"); }, () => "", () => masked, () => "undefined\n"]) {
      expect(g.resolve(masked, `${masked}/lib/node_modules`, ask, "linux")).toEqual({ prefix: "", root: "" });
    }
  });
});

describe.skipIf(process.platform === "win32")("real npm", () => {
  const env = (d: string, prefix: string) => ({ ...process.env, npm_config_prefix: prefix, npm_config_cache: join(d, "cache"), npm_config_update_notifier: "false" });

  it("`npm exec -c` hands the program it starts the real global prefix (npm 11/12 redact only what npm prints)", () => {
    const d = scratch("agend-m3806-exec-");
    const prefix = join(d, `pfx-${UUID}`);
    mkdirSync(join(prefix, "lib"), { recursive: true });
    const r = spawnSync("npm", g.ASK, { cwd: g.neutralCwd(), encoding: "utf8", timeout: 60_000, env: env(d, prefix) });
    expect(r.status, r.stderr).toBe(0);
    expect(g.lastLine(r.stdout)).toBe(prefix);
  });

  it("inside a project, its own node_modules/.bin/node answers; from the filesystem root, npm's node does (Fable #4526 F2)", () => {
    const d = scratch("agend-m3806-exec-");
    const prefix = join(d, `pfx-${UUID}`);
    mkdirSync(join(prefix, "lib"), { recursive: true });
    const project = projectWithNodeShim("/from-project-local-node");
    const inside = spawnSync("npm", g.ASK, { cwd: project, encoding: "utf8", timeout: 60_000, env: env(d, prefix) });
    expect(g.lastLine(inside.stdout), "the hazard, as npm has it").toBe("/from-project-local-node");
    expect(g.confirmed(redact(prefix), g.lastLine(inside.stdout)), "and the check refuses it").toBe("");
    const neutral = spawnSync("npm", g.ASK, { cwd: g.neutralCwd(), encoding: "utf8", timeout: 60_000, env: env(d, prefix) });
    expect(g.lastLine(neutral.stdout)).toBe(prefix);
  });
});

describe.skipIf(process.platform === "win32")("install.sh: the prefix/sudo step never judges or creates a redacted folder", () => {
  const script = readFileSync(join(REPO, "install.sh"), "utf8");
  const step = /# >>> npm-prefix sudo[^\n]*\n([\s\S]*?)# <<< npm-prefix sudo/.exec(script)?.[1] ?? "";

  /**
   * The block under `set -euo pipefail`, with an npm that behaves like npm 11/12 for a UUID path: `config get prefix`
   * refuses (or, the other variant, redacts), `prefix -g` redacts, and `exec -c` runs the command with npm's
   * environment and the cwd's node_modules/.bin first on PATH (as npm does). `answer` overrides what a child is told.
   */
  function run(prefixIn: (home: string) => string, opts: { execWorks?: boolean; config?: "refuses" | "redacts"; cwd?: string; answer?: string } = {}) {
    const { execWorks = true, config = "refuses" } = opts;
    const d = scratch("agend-m3806-sh-");
    const home = join(d, "home"), bin = join(d, "bin");
    mkdirSync(home); mkdirSync(bin);
    const prefix = prefixIn(home);
    const nodeDir = process.execPath.replace(/\/[^/]*$/, "");
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    writeFileSync(join(bin, "npm"), `#!/bin/sh
real=${JSON.stringify(prefix)}
red=$(printf '%s\\n' "$real" | sed -E 's/${uuid}/***/g')
if [ "$1 $2 $3" = "config get prefix" ]; then
  if [ "$red" != "$real" ] && [ ${JSON.stringify(config)} = refuses ]; then echo "npm error The prefix option is protected, and cannot be retrieved in this way" >&2; exit 1; fi
  printf '%s\\n' "$red"; exit 0
fi
if [ "$1 $2" = "prefix -g" ]; then printf '%s\\n' "$red"; exit 0; fi
if [ "$1 $2" = "exec -c" ]; then
  [ -n "$EXEC_FAILS" ] && exit 1
  echo "npm notice run $3" >&2
  npm_config_global_prefix=\${ANSWER:-$real} PATH="$PWD/node_modules/.bin:${nodeDir}:/usr/bin:/bin" sh -c "$3"; exit $?
fi
echo "unexpected npm $*" >&2; exit 9
`);
    chmodSync(join(bin, "npm"), 0o755);
    const r = spawnSync("bash", ["-c", `set -euo pipefail
error() { echo "ERROR: $1" >&2; exit 1; }
SUDO=sudo
${step}
printf 'SUDO=%s\\n' "$SUDO"
printf 'PREFIX=%s\\n' "$NPM_PREFIX"
`], { cwd: opts.cwd ?? d, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...(execWorks ? {} : { EXEC_FAILS: "1" }), ...(opts.answer ? { ANSWER: opts.answer } : {}) } });
    return { r, home, prefix };
  }
  const STOP = "ERROR: npm did not say where it installs global packages. Run: npm prefix -g";

  for (const config of ["refuses", "redacts"] as const) {
    it(`a UUID in the prefix (npm config get prefix ${config}): the real prefix is judged and created, without sudo; never /usr/local or a \`***\` folder`, () => {
      const { r, home, prefix } = run(h => join(h, `.npm-${UUID}`), { config });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`PREFIX=${prefix}\n`);
      expect(r.stdout).toContain("SUDO=\n");
      expect(existsSync(join(prefix, "lib"))).toBe(true);
      expect(readdirSync(home)).toEqual([`.npm-${UUID}`]);
    });

    it(`npm can't be asked again (npm config get prefix ${config}): it stops with the reason, and creates nothing`, () => {
      const { r, home } = run(h => join(h, `.npm-${UUID}`), { execWorks: false, config });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(STOP);
      expect(r.stdout).not.toContain("PREFIX=");
      expect(readdirSync(home)).toEqual([]);
    });
  }

  it("run from inside a project with its own node_modules/.bin/node: the ask runs from /, so npm's answer is used, not the project's (Fable #4526 F2)", () => {
    const project = projectWithNodeShim("/from-project-local-node");
    const { r, prefix } = run(h => join(h, `.npm-${UUID}`), { cwd: project });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`PREFIX=${prefix}\n`);
  });

  it("an answer npm would not have printed that way (another path): it stops, and creates nothing", () => {
    for (const answer of ["/from-project-local-node", `/elsewhere/.npm-${UUID}`]) {
      const { r, home } = run(h => join(h, `.npm-${UUID}`), { answer });
      expect(r.status, answer).toBe(1);
      expect(r.stderr).toContain(STOP);
      expect(readdirSync(home)).toEqual([]);
    }
  });

  it("a prefix without a UUID is read as before (npm is not asked again)", () => {
    const { r, prefix } = run(h => join(h, ".npm-global"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`PREFIX=${prefix}\n`);
    expect(r.stderr).not.toContain("npm notice run");
  });

  it("the old-package cleanup uses that prefix, not a second `npm prefix -g`; the website copy is identical", () => {
    expect(script).not.toMatch(/rm -f "\$\(npm prefix -g/);
    expect(script).toContain('rm -f "$NPM_PREFIX/bin/agend"');
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });
});

describe.skipIf(process.platform === "win32")("chat /update: the npm that manages the running install", () => {
  const NVM = `/home/u/.nvm-${UUID}/versions/node/v22.23.1`;
  const PKG = `${NVM}/lib/node_modules/@songsid/agend`;
  function deps(answer: string | null = NVM): DispatchDeps & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked, packageDir: PKG, execPath: `${PKG}/node_modules/@songsid/agend-node-linux-x64/bin/node`, pathEnv: "/nowhere",
      isExecutable: async path => path === `${NVM}/bin/npm`,
      run: async (command, args, _t, _env, cwd) => {
        asked.push(`${command} ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);
        if (args[0] === "root") return { status: 0, stdout: `${redact(`${NVM}/lib/node_modules`)}\n` };
        if (args[0] === "prefix") return { status: 0, stdout: `${redact(NVM)}\n` };
        if (args.join(" ") === g.ASK.join(" ")) return answer === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${answer}\n` };
        return { status: 1, stdout: "" };
      },
      readFile: async path => {
        if (path === `${PKG}/package.json`) return JSON.stringify({ name: "@songsid/agend", version: "2.4.0", bin: { agend: "dist/cli.js" } });
        throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
      },
      realpath: async path => path,
    };
  }

  it("npm prints `***` for its root and prefix: they are asked from the filesystem root, the way npm tells a child, and the install is found", async () => {
    const d = deps();
    expect(await npmForRunningInstall(d)).toEqual({ root: `${NVM}/lib/node_modules`, prefix: NVM });
    expect(d.asked).toContain(`npm ${g.ASK.join(" ")} (in ${g.neutralCwd()})`);
  });

  it("npm can't be asked again, or answers a path it would not have printed that way: not taken (never the redacted path)", async () => {
    for (const answer of [null, "/from-project-local-node", `/home/v/.nvm-${UUID}/versions/node/v22.23.1`]) {
      const result = await npmForRunningInstall(deps(answer));
      expect(result, String(answer)).toHaveProperty("reason");
    }
  });
});

describe.skipIf(process.platform === "win32")("the installer's own runner", () => {
  it("runs a program where it is told to (the ask's cwd reaches spawn)", () => {
    const installer = require("../launcher/agend-install.cjs") as { defaultDeps(): { run(cmd: string, args: string[], opts?: { cwd?: string }): { stdout: string } } };
    expect(installer.defaultDeps().run("pwd", [], { cwd: "/" }).stdout).toBe("/\n");
  });
});

describe("agend update's sudo check", () => {
  it("reads the prefix through the helper: a refused answer falls to `npm prefix -g`, a redacted one is asked from the filesystem root", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const at = cli.indexOf('let configured = said("npm config get prefix");');
    expect(at).toBeGreaterThan(0);
    const block = cli.slice(at, at + 600);
    expect(block).toContain('configured = said("npm prefix -g")');
    expect(block).toContain("npmGlobalPrefix.resolve(configured, undefined,");
    expect(block).toContain("npmGlobalPrefix.neutralCwd()");
    expect(block).toContain("if (!prefix) throw");
    expect(cli).not.toMatch(/const prefix = execSync\("npm config get prefix"/);
  });
});

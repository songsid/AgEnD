/**
 * M-3806: npm 11 and 12 redact UUID-like text in everything they print. For a global prefix whose path contains a UUID,
 * `npm prefix -g` and `npm root -g` print `***` in its place, and `npm config get prefix` refuses ("The prefix option is
 * protected", npm 10 too). The installer then checked, locked or created a folder that doesn't exist; install.sh fell
 * back to /usr/local. A program npm starts still gets the real path in `npm_config_global_prefix`, so a redacted or
 * missing answer is asked again that way.
 *
 * Here: the shared helper; real `npm exec` handing the prefix to a child; install.sh's prefix/sudo step; chat
 * `/update`'s npm lookup; the CLI's sudo check. The installer and the update's compat path are covered next to their
 * own rigs (agend-install-2264, update-install-1446). The real-npm-11/12 reproduction is in
 * docs/evidence/npm-masked-prefix-m3806/.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { npmForRunningInstall, type DispatchDeps } from "../src/update-dispatch.js";

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, "..");
const g = require("../launcher/npm-global-prefix.cjs") as {
  MASK: string; PRINT: string; ASK: string[]; masked(t: unknown): boolean; lastLine(t: unknown): string;
  rootOf(prefix: string, platform?: string): string; resolve(p: string, r: string | undefined, ask: () => string, platform?: string): { prefix: string; root?: string };
};
const roots: string[] = [];
afterAll(() => { for (const r of roots) { try { chmodSync(r, 0o755); } catch { /* gone */ } rmSync(r, { recursive: true, force: true }); } });
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };
const UUID = "0b7e5a2c-3f1d-4c6e-9a8b-1234567890ab";
/** What npm 11/12 print for a path (@npmcli/redact's UUID matcher, as far as these paths go). */
const redact = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "***");

describe("the shared helper", () => {
  it("tells a redacted answer, takes npm's last line, and lays out the root as npm does", () => {
    expect(g.masked("/home/u/pfx-***")).toBe(true);
    expect(g.masked("/home/u/.npm-global")).toBe(false);
    expect(g.masked(undefined)).toBe(false);
    expect(g.lastLine("npm warn x\n/home/u/p\n\n")).toBe("/home/u/p");
    expect(g.lastLine("")).toBe("");
    expect(g.rootOf("/home/u/p", "linux")).toBe("/home/u/p/lib/node_modules");
    expect(g.rootOf("/home/u/p", "darwin")).toBe("/home/u/p/lib/node_modules");
    expect(g.rootOf("C:\\Users\\u\\AppData\\Roaming\\npm", "win32")).toBe("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules");
    expect(g.ASK).toEqual(["exec", "-c", "node -p process.env.npm_config_global_prefix"]);
  });

  it("an unredacted answer is used as npm gave it, and npm is not asked again", () => {
    let asked = 0;
    const ask = () => { asked += 1; return "/elsewhere\n"; };
    expect(g.resolve("/home/u/p\n", "/home/u/p/lib/node_modules\n", ask, "linux")).toEqual({ prefix: "/home/u/p", root: "/home/u/p/lib/node_modules" });
    expect(g.resolve("/home/u/p\n", undefined, ask)).toEqual({ prefix: "/home/u/p" });
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

  it("a missing prefix (a refused `npm config get prefix`) is asked the same way", () => {
    const real = `/home/u/pfx-${UUID}`;
    expect(g.resolve("", undefined, () => `${real}\n`)).toEqual({ prefix: real });
    expect(g.resolve("", "", () => `${real}\n`, "linux")).toEqual({ prefix: real, root: `${real}/lib/node_modules` });
  });

  it("no usable second answer (failed, empty, still redacted, `undefined`): nothing, never the redacted path", () => {
    const masked = redact(`/home/u/pfx-${UUID}`);
    for (const ask of [() => { throw new Error("spawn failed"); }, () => "", () => masked, () => "undefined\n"]) {
      expect(g.resolve(masked, `${masked}/lib/node_modules`, ask, "linux")).toEqual({ prefix: "", root: "" });
    }
  });
});

describe.skipIf(process.platform === "win32")("real npm", () => {
  it("`npm exec -c` hands the program it starts the real global prefix (npm 11/12 redact only what npm prints)", () => {
    const d = scratch("agend-m3806-exec-");
    const prefix = join(d, `pfx-${UUID}`);
    mkdirSync(join(prefix, "lib"), { recursive: true });
    const r = spawnSync("npm", g.ASK, { cwd: d, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, npm_config_prefix: prefix, npm_config_cache: join(d, "cache"), npm_config_update_notifier: "false" } });
    expect(r.status, r.stderr).toBe(0);
    expect(g.lastLine(r.stdout)).toBe(prefix);
  });
});

describe.skipIf(process.platform === "win32")("install.sh: the prefix/sudo step never judges or creates a redacted folder", () => {
  const script = readFileSync(join(REPO, "install.sh"), "utf8");
  const step = /# >>> npm-prefix sudo[^\n]*\n([\s\S]*?)# <<< npm-prefix sudo/.exec(script)?.[1] ?? "";

  /** The block under `set -euo pipefail`, with an npm that redacts like npm 11/12 and hands its children the real prefix. */
  function run(prefixIn: (home: string) => string, execWorks = true, config: "refuses" | "redacts" = "refuses") {
    const d = scratch("agend-m3806-sh-");
    const home = join(d, "home"), bin = join(d, "bin");
    mkdirSync(home); mkdirSync(bin);
    const prefix = prefixIn(home);
    const nodeDir = process.execPath.replace(/\/[^/]*$/, "");
    writeFileSync(join(bin, "npm"), `#!/bin/sh
real=${JSON.stringify(prefix)}
if [ "$1 $2 $3" = "config get prefix" ]; then
  # npm 10-12 refuse a value that looks like a secret; the redacting variant is what npm 11/12 do to every other answer.
  if printf '%s' "$real" | grep -Eq '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then
    [ ${JSON.stringify(config)} = refuses ] && { echo "npm error The prefix option is protected, and cannot be retrieved in this way" >&2; exit 1; }
    printf '%s\\n' "$real" | sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/***/g'; exit 0
  fi
  printf '%s\\n' "$real"; exit 0
fi
if [ "$1 $2" = "exec -c" ]; then
  [ -n "$EXEC_FAILS" ] && exit 1
  echo "npm notice run $3" >&2
  npm_config_global_prefix="$real" PATH=${JSON.stringify(`${nodeDir}:/usr/bin:/bin`)} sh -c "$3"; exit $?
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
`], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...(execWorks ? {} : { EXEC_FAILS: "1" }) } });
    return { r, home, prefix };
  }

  for (const config of ["refuses", "redacts"] as const) {
    it(`a UUID in the prefix (npm config get prefix ${config}): the real prefix is judged and created, without sudo; never /usr/local or a \`***\` folder`, () => {
      const { r, home, prefix } = run(h => join(h, `.npm-${UUID}`), true, config);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`PREFIX=${prefix}\n`);
      expect(r.stdout).toContain("SUDO=\n");
      expect(existsSync(join(prefix, "lib"))).toBe(true);
      expect(readdirSync(home)).toEqual([`.npm-${UUID}`]);
    });

    it(`npm can't be asked again (npm config get prefix ${config}): it stops with the reason, and creates nothing`, () => {
      const { r, home } = run(h => join(h, `.npm-${UUID}`), false, config);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("ERROR: npm did not say where it installs global packages (npm config get prefix / npm prefix -g).");
      expect(r.stdout).not.toContain("PREFIX=");
      expect(readdirSync(home)).toEqual([]);
    });
  }

  it("a prefix without a UUID is read as before (npm is not asked again)", () => {
    const { r, prefix } = run(h => join(h, ".npm-global"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`PREFIX=${prefix}\n`);
    expect(r.stderr).not.toContain("npm notice run");
  });

  it("the old-package cleanup uses that prefix, not a second `npm prefix -g`; the website copy is identical", () => {
    expect(script).not.toMatch(/\$\(npm prefix -g/);
    expect(script).toContain('rm -f "$NPM_PREFIX/bin/agend"');
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });
});

describe.skipIf(process.platform === "win32")("chat /update: the npm that manages the running install", () => {
  const NVM = `/home/u/.nvm-${UUID}/versions/node/v22.23.1`;
  const PKG = `${NVM}/lib/node_modules/@songsid/agend`;
  function deps(execWorks = true): DispatchDeps & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked, packageDir: PKG, execPath: `${PKG}/node_modules/@songsid/agend-node-linux-x64/bin/node`, pathEnv: "/nowhere",
      isExecutable: async path => path === `${NVM}/bin/npm`,
      run: async (command, args) => {
        asked.push(`${command} ${args.join(" ")}`);
        if (args[0] === "root") return { status: 0, stdout: `${redact(`${NVM}/lib/node_modules`)}\n` };
        if (args[0] === "prefix") return { status: 0, stdout: `${redact(NVM)}\n` };
        if (args.join(" ") === g.ASK.join(" ")) return execWorks ? { status: 0, stdout: `${NVM}\n` } : { status: 1, stdout: "" };
        return { status: 1, stdout: "" };
      },
      readFile: async path => {
        if (path === `${PKG}/package.json`) return JSON.stringify({ name: "@songsid/agend", version: "2.4.0", bin: { agend: "dist/cli.js" } });
        throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
      },
      realpath: async path => path,
    };
  }

  it("npm prints `***` for its root and prefix: they are asked the way npm tells a child, and the install is found", async () => {
    const d = deps();
    expect(await npmForRunningInstall(d)).toEqual({ root: `${NVM}/lib/node_modules`, prefix: NVM });
    expect(d.asked).toContain(`npm ${g.ASK.join(" ")}`);
  });

  it("npm can't be asked again: not taken (never the redacted path)", async () => {
    const result = await npmForRunningInstall(deps(false));
    expect(result).toHaveProperty("reason");
    expect(JSON.stringify(result)).not.toContain(`${NVM}/lib/node_modules"`);
  });
});

describe("agend update's sudo check", () => {
  it("reads the prefix through the helper, so a refused or redacted answer is asked again, not judged", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const at = cli.indexOf('try { configured = execSync("npm config get prefix", quiet); }');
    expect(at).toBeGreaterThan(0);
    const block = cli.slice(at, at + 500);
    expect(block).toContain("npmGlobalPrefix.resolve(configured, undefined,");
    expect(block).toContain("npmGlobalPrefix.ASK");
    expect(block).toContain('if (!prefix) throw');
    expect(cli).not.toMatch(/const prefix = execSync\("npm config get prefix"/);
  });
});

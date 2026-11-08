/**
 * #3440: chat `/update` under an nvm install. The fleet service's PATH can list a system npm (`/usr/bin/npm`) before the
 * nvm Node that installed AgEnD; that npm's global root has no AgEnD, so `/update` refused with "… is not an installed
 * AgEnD package". The npm beside the running package is asked first, and the updater runs with its bin directory first
 * on PATH, so the CLI's own npm checks use the same npm. An npm is accepted only when its global root is the running
 * package's own. (From the 雲晴家 fleet operator's patch, adapted to that acceptance rule.)
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colocatedNpm, DELAYED_UPDATE_SCRIPT, resolveInstalledAgend, type DispatchDeps } from "../src/update-dispatch.js";

const NVM = "/home/u/.nvm/versions/node/v22.23.1";
const NVM_PKG = `${NVM}/lib/node_modules/@songsid/agend`;
const MANIFEST = JSON.stringify({ name: "@songsid/agend", version: "2.3.5-beta.1", bin: { agend: "dist/cli.js" } });

/**
 * npm binaries (by path; `npm` = PATH's, at /path-npm/bin/npm) → their global root and prefix; anything else on disk is
 * the nvm install. Bare `npm` resolves through the PATH it is given (as execFile would), else the fleet's.
 */
const PATH_NPM = "/path-npm/bin/npm";
function deps(npms: Record<string, { root: string; prefix: string } | null>, packageDir: string | null): DispatchDeps & { asked: string[] } {
  const asked: string[] = [];
  const table: Record<string, { root: string; prefix: string } | null> = Object.fromEntries(Object.entries(npms).map(([k, v]) => [k === "npm" ? PATH_NPM : k, v]));
  return {
    asked,
    packageDir,
    execPath: `${NVM_PKG}/node_modules/@songsid/agend-node-linux-x64/bin/node`,   // the bundled Node: no npm beside it
    pathEnv: "/path-npm/bin",                                                      // where PATH's npm lives
    isExecutable: async path => path in table,
    run: async (command, args, _t, env) => {
      const path = (env?.PATH ?? "/path-npm/bin").split(":");
      const resolved = command === "npm" ? path.map(d => `${d}/npm`).find(p => p in table) ?? "npm (none)" : command;
      asked.push(`${resolved} ${args.join(" ")}`);
      const npm = table[resolved];
      if (!npm) return { status: null, stdout: "" };
      return { status: 0, stdout: args[0] === "root" ? `${npm.root}\n` : `${npm.prefix}\n` };
    },
    readFile: async path => {
      if (path === `${NVM_PKG}/package.json`) return MANIFEST;
      throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
    },
    realpath: async path => {
      if (path === `${NVM_PKG}/dist/cli.js` || path === `${NVM}/bin/agend`) return `${NVM_PKG}/dist/cli.js`;
      if ([NVM_PKG, `${NVM}/lib/node_modules`, "/usr/lib/node_modules"].includes(path)) return path;
      throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

const SYSTEM = { root: "/usr/lib/node_modules", prefix: "/usr" };
const NVM_NPM = { root: `${NVM}/lib/node_modules`, prefix: NVM };

describe("#3440 the npm beside the running package", () => {
  it("is `<prefix>/bin/npm`, run by `<prefix>/bin/node`, for a POSIX global install", () => {
    const nvm = { command: `${NVM}/bin/node`, args: [`${NVM}/bin/npm`] };
    expect(colocatedNpm(NVM_PKG, "linux")).toEqual(nvm);
    expect(colocatedNpm(`${NVM_PKG}/`, "linux")).toEqual(nvm);
    expect(colocatedNpm("/usr/lib/node_modules/@songsid/agend", "linux")).toEqual({ command: "/usr/bin/node", args: ["/usr/bin/npm"] });
  });

  it("is not guessed for a checkout, another package, Windows or nothing", () => {
    expect(colocatedNpm("/home/u/src/agend", "linux")).toBeNull();
    expect(colocatedNpm(`${NVM}/lib/node_modules/@other/agend`, "linux")).toBeNull();
    expect(colocatedNpm("/home/u/x/node_modules/@songsid/agend", "linux")).toBeNull();
    expect(colocatedNpm("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@songsid\\agend", "win32")).toBeNull();
    expect(colocatedNpm(null, "linux")).toBeNull();
    expect(colocatedNpm(undefined, "linux")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("#3440 resolveInstalledAgend under nvm with a system npm first on PATH", () => {
  it("finds the nvm install through the npm beside the running package", async () => {
    const d = deps({ npm: SYSTEM, [`${NVM}/bin/npm`]: NVM_NPM }, NVM_PKG);
    expect(await resolveInstalledAgend(d)).toEqual({ ok: true, agend: `${NVM}/bin/agend`, version: "2.3.5-beta.1" });
    expect(d.asked.every(a => a.startsWith(`${NVM}/bin/npm `))).toBe(true);
  });

  it("without a package directory, PATH's npm is all it asks — and its refusal stands (the old behaviour)", async () => {
    const d = deps({ npm: SYSTEM, [`${NVM}/bin/npm`]: NVM_NPM }, null);
    expect(await resolveInstalledAgend(d)).toEqual({ ok: false, reason: "/usr/lib/node_modules/@songsid/agend is not an installed AgEnD package" });
    expect(d.asked.every(a => a.startsWith(`${PATH_NPM} `))).toBe(true);
  });

  it("falls back to PATH's npm when the npm beside it is missing", async () => {
    const d = deps({ npm: NVM_NPM }, NVM_PKG);
    // With no npm in the install's bin, PATH's npm is asked in the launch PATH (the install's bin first): no npmDir.
    expect(await resolveInstalledAgend(d)).toEqual({ ok: true, agend: `${NVM}/bin/agend`, version: "2.3.5-beta.1" });
    expect(d.asked.every(a => a.startsWith(`${PATH_NPM} `))).toBe(true);
  });

  it("an npm whose root is not the running package's is never taken: no npm manages it → a plain refusal", async () => {
    // The npm beside the package points somewhere else (a custom global prefix), and so does PATH's.
    const d = deps({ [`${NVM}/bin/npm`]: SYSTEM, npm: SYSTEM }, NVM_PKG);
    expect(await resolveInstalledAgend(d)).toEqual({ ok: false, reason: `no npm here manages the running AgEnD: expected the npm whose global root is ${NVM}/lib/node_modules (tried ${NVM}/bin/npm → /usr/lib/node_modules; ${PATH_NPM} (first on PATH, ahead of ${NVM}/bin) → /usr/lib/node_modules)` });
  });
});

describe.skipIf(process.platform === "win32")("#3440 the delayed updater puts the installed agend's bin directory first on PATH", () => {
  it("runs `<agend> update` with `<prefix>/bin` ahead of the inherited PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "agend-3440-bin-"));
    const agend = join(bin, "agend");
    writeFileSync(agend, '#!/bin/sh\nprintf "%s|%s" "$1" "$PATH"\n');
    chmodSync(agend, 0o755);
    const out = execFileSync("sh", ["-c", DELAYED_UPDATE_SCRIPT.replace("sleep 2", "true"), "sh", agend], {
      encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(out).toBe(`update|${bin}:/usr/bin:/bin`);
  });

  it("keeps the path as data: a path with spaces and quotes is not spliced into the script", () => {
    const bin = join(mkdtempSync(join(tmpdir(), "agend-3440-")), `it's a "dir"`);
    execFileSync("mkdir", ["-p", bin]);
    const agend = join(bin, "agend");
    writeFileSync(agend, '#!/bin/sh\nprintf "%s" "${PATH%%:*}"\n');
    chmodSync(agend, 0o755);
    const out = execFileSync("sh", ["-c", DELAYED_UPDATE_SCRIPT.replace("sleep 2", "true"), "sh", agend], {
      encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(out).toBe(bin);
  });
});

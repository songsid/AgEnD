/**
 * M-2457 PR B (docs/design/bundled-tmux.md §5): which tmux AgEnD runs, on which socket, with which environment.
 *  - Off (this release: nothing sets AGEND_BUNDLED_TMUX=1): every answer is what each call site used before — "tmux"
 *    on PATH, getTmuxSocketName(), the caller's environment, no -f.
 *  - On: AGEND_TMUX_BIN (absolute + executable, else refused with the fix), else the receipt-verified bundle copied to
 *    <AGEND_HOME>/tmux/<version>-<sha12>/ (never a PATH fallback); the `agend` socket for the real home; the bundled
 *    terminfo first, true colour, AGEND_TMUX for panes, never a caller's $TMUX; AgEnD's own -f config.
 * Isolation: temp dirs; no tmux runs.
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTmuxSocketName } from "../src/paths.js";
import {
  AGEND_TMUX_CONF, BUNDLED_TMUX_ENV, BUNDLED_TMUX_SOCKET, TMUX_BIN_ENV, TmuxUnavailableError, bundledTmuxEnabled, insideFleetTmux,
  resetTmuxResolution, resolveTmux, socketFor, tmuxArgs, tmuxConfArgs, tmuxEnv, tmuxEnvOption, tmuxSocket,
} from "../src/tmux-binary.js";

const require = createRequire(import.meta.url);
const ON = { [BUNDLED_TMUX_ENV]: "1" } as NodeJS.ProcessEnv;
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-tmuxbin-")); roots.push(d); return d; };
afterEach(() => { resetTmuxResolution(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("off (this release): every answer is what the call sites used before", () => {
  it("tmux on PATH, getTmuxSocketName(), the caller's own environment, no -f", () => {
    const env = { PATH: "/usr/bin", TMUX: "/tmp/tmux-1/default,1,0" } as NodeJS.ProcessEnv;
    expect(bundledTmuxEnabled(env)).toBe(false);
    expect(resolveTmux({ env })).toEqual({ binary: "tmux", terminfo: null, source: "system", version: null });
    expect(tmuxSocket(env)).toBe(getTmuxSocketName());
    const socket = getTmuxSocketName();
    expect(tmuxArgs(["ls"], env)).toEqual(socket ? ["-L", socket, "ls"] : ["ls"]);
    expect(tmuxConfArgs(env)).toEqual([]);
    expect(tmuxEnv(env)).toBe(env);                       // the very object: nothing added, nothing removed
  });

  it.each(["", "0", "true", "yes", " 1", "1 "])("the switch is exactly \"1\": %j is off", (v) => {
    expect(bundledTmuxEnabled({ [BUNDLED_TMUX_ENV]: v })).toBe(false);
  });

  it("tmuxEnvOption() spreads nothing while off (the process's switch is unset here)", () => {
    expect(process.env[BUNDLED_TMUX_ENV]).toBeUndefined();
    expect(tmuxEnvOption()).toEqual({});
  });
});

describe("on: AGEND_TMUX_BIN", () => {
  it("an absolute path to an executable file is used as is", () => {
    const d = scratch();
    const bin = join(d, "tmux"); writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
    expect(resolveTmux({ env: { ...ON, [TMUX_BIN_ENV]: bin }, agendHome: d })).toEqual({ binary: bin, terminfo: null, source: "override", version: null });
  });

  it.each([
    ["a relative path", () => "tmux", /is not an absolute path/],
    ["a missing file", () => "/nonexistent/tmux", /is not a file/],
    ["a directory", (d: string) => d, /is not a file/],
    ["a file that is not executable", (d: string) => { const f = join(d, "tmux"); writeFileSync(f, "x"); chmodSync(f, 0o644); return f; }, /is not executable/],
  ])("%s is refused with what to do", (_why, make, reason) => {
    const d = scratch();
    expect(() => resolveTmux({ env: { ...ON, [TMUX_BIN_ENV]: make(d) }, agendHome: d })).toThrow(TmuxUnavailableError);
    try { resolveTmux({ env: { ...ON, [TMUX_BIN_ENV]: make(d) }, agendHome: d }); } catch (e) {
      expect((e as Error).message).toMatch(reason);
      expect((e as Error).message).toMatch(/absolute path of a tmux 3\.6a or newer, or unset it/);
    }
  });
});

/** A package dir with this repo's launcher/, pinning a tmux package for linux-x64, and (opts) that package + its receipt. */
function pkg(opts: { pin?: boolean; installed?: boolean; receipt?: boolean; receiptSha?: string } = {}) {
  const root = scratch();
  const dir = join(root, "pkg");
  mkdirSync(dir, { recursive: true });
  cpSync(join(process.cwd(), "launcher"), join(dir, "launcher"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.4.0",
    ...(opts.pin === false ? {} : { optionalDependencies: { "@songsid/agend-tmux-linux-x64": "3.8.0" } }) }));
  const home = join(dir, "node_modules", "@songsid", "agend-tmux-linux-x64");
  const bin = join(home, "bin", "tmux");
  if (opts.installed !== false) {
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(home, "share", "terminfo", "t"), { recursive: true });
    writeFileSync(join(home, "share", "terminfo", "t", "tmux-256color"), "terminfo");
    writeFileSync(bin, "#!/bin/sh\necho tmux 3.8\n"); chmodSync(bin, 0o755);
    if (opts.receipt !== false) {
      const bundle = require(join(dir, "launcher", "tmux-bundle.cjs"));
      const st = statSync(bin);
      bundle.writeReceipt(dir, { version: "3.8.0" }, { real: bin, tmux: "3.8", sha256: opts.receiptSha ?? createHash("sha256").update(readFileSync(bin)).digest("hex"), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }, { platform: "linux", arch: "x64" });
    }
  }
  return { dir, bin, agendHome: join(root, "home") };
}

describe("on: the bundled tmux", () => {
  it("is copied once to <AGEND_HOME>/tmux/<version>-<sha12>/ with its terminfo, and run from there", () => {
    const p = pkg();
    const r = resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    const sha = createHash("sha256").update(readFileSync(p.bin)).digest("hex");
    expect(r).toEqual({ source: "bundled", version: "3.8", binary: join(p.agendHome, "tmux", `3.8-${sha.slice(0, 12)}`, "bin", "tmux"),
      terminfo: join(p.agendHome, "tmux", `3.8-${sha.slice(0, 12)}`, "share", "terminfo") });
    expect(createHash("sha256").update(readFileSync(r.binary)).digest("hex")).toBe(sha);
    expect(statSync(r.binary).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(r.terminfo!, "t", "tmux-256color"), "utf8")).toBe("terminfo");
    // A good copy is reused, not copied again; a copy that no longer matches the receipt is replaced.
    const before = statSync(r.binary).mtimeMs;
    resetTmuxResolution();
    expect(resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome }).binary).toBe(r.binary);
    expect(statSync(r.binary).mtimeMs).toBe(before);
    writeFileSync(r.binary, "#!/bin/sh\necho tampered\n");
    resetTmuxResolution();
    resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    expect(createHash("sha256").update(readFileSync(r.binary)).digest("hex")).toBe(sha);
  });

  it.each([
    ["this release pins none for the host", { pin: false }, /has no bundled tmux for linux-x64/],
    ["the package was not installed", { installed: false }, /is not installed or not verified/],
    ["the package has no receipt (not verified)", { receipt: false }, /is not installed or not verified/],
  ])("is refused, never PATH's tmux instead, when %s", (_why, opts, reason) => {
    const p = pkg(opts);
    expect(() => resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome })).toThrow(reason);
    expect(existsSync(join(p.agendHome, "tmux"))).toBe(false);
  });

  it("is refused when the copied bytes are not the receipt's (changed while copied): no copy is left to be trusted", () => {
    // The receipt is checked by size + mtime before the copy; its sha256 is checked on the copy. A receipt sha that the
    // file does not have stands for a file that changed between the two.
    const p = pkg({ receiptSha: "0".repeat(64) });
    expect(() => resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome }))
      .toThrow(/changed while it was being copied/);
    expect(() => resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome })).toThrow(TmuxUnavailableError);
    const dir = join(p.agendHome, "tmux");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);   // neither the destination nor a .tmp
  });
});

describe("on: socket, environment, config, attach", () => {
  it("the real home's socket is agend (never tmux's default); any other home keeps its isolated name; off is as before", () => {
    expect(socketFor(true, true, null)).toBe(BUNDLED_TMUX_SOCKET);
    expect(socketFor(true, false, "agend-1a2b3c")).toBe("agend-1a2b3c");
    expect(socketFor(false, true, null)).toBeNull();
    expect(socketFor(false, false, "agend-1a2b3c")).toBe("agend-1a2b3c");
  });

  it("the environment: bundled terminfo first, true colour, AGEND_TMUX for panes, no caller $TMUX / $TMUX_PANE", () => {
    const p = pkg();
    const env = tmuxEnv({ ...ON, TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", TERMINFO_DIRS: "/opt/ti", PATH: "/usr/bin" },
      { env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    const r = resolveTmux({ env: ON, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.TERMINFO_DIRS).toBe(`${r.terminfo}:/opt/ti`);
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.AGEND_TMUX).toBe(r.binary);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("AgEnD's own config is written once and passed with -f (the user's ~/.tmux.conf is never read)", () => {
    const d = scratch();
    expect(tmuxConfArgs(ON, d)).toEqual(["-f", join(d, "tmux", "agend-tmux.conf")]);
    expect(readFileSync(join(d, "tmux", "agend-tmux.conf"), "utf8")).toBe(AGEND_TMUX_CONF);
    expect(AGEND_TMUX_CONF).toMatch(/set -g default-terminal "tmux-256color"/);
    // A changed file is put back to AgEnD's.
    writeFileSync(join(d, "tmux", "agend-tmux.conf"), "set -g mouse off\n");
    resetTmuxResolution();
    tmuxConfArgs(ON, d);
    expect(readFileSync(join(d, "tmux", "agend-tmux.conf"), "utf8")).toBe(AGEND_TMUX_CONF);
  });

  it("agend attach is 'inside' only this fleet's tmux when on; any $TMUX as before when off", () => {
    expect(insideFleetTmux(undefined, true, "agend")).toBe(false);
    expect(insideFleetTmux("/tmp/tmux-1000/agend,123,0", true, "agend")).toBe(true);
    expect(insideFleetTmux("/tmp/tmux-1000/default,123,0", true, "agend")).toBe(false);   // the user's own tmux
    expect(insideFleetTmux("/tmp/tmux-1000/default,123,0", false, null)).toBe(true);
    expect(insideFleetTmux("/tmp/tmux-1000/agend-1a2b3c,9,1", true, "agend-1a2b3c")).toBe(true);
  });
});

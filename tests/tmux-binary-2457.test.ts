/**
 * M-2457 (docs/design/bundled-tmux.md §5): which tmux AgEnD runs, on which socket, with which environment. Always
 * AgEnD's own tmux (C-4); there is no PATH fallback and no switch back.
 *  - AGEND_TMUX_BIN (absolute + executable, else refused with the fix), else the receipt-verified bundle copied to
 *    <AGEND_HOME>/tmux/<version>-<sha12>/ (never a PATH fallback); the `agend` socket for the real home; the bundled
 *    terminfo first, true colour, AGEND_TMUX for panes, never a caller's $TMUX; AgEnD's own -f config.
 * Isolation: temp dirs; no tmux runs.
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGEND_TMUX_CONF, BUNDLED_TMUX_SOCKET, TMUX_BIN_ENV, TmuxUnavailableError, insideFleetTmux,
  resetTmuxResolution, resolveTmux, socketFor, tmuxArgs, tmuxConfArgs, tmuxEnv, tmuxEnvOption, tmuxSocket,
} from "../src/tmux-binary.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-tmuxbin-")); roots.push(d); return d; };
afterEach(() => {
  resetTmuxResolution();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("on: AGEND_TMUX_BIN", () => {
  it("an absolute path to an executable file is used as is", () => {
    const d = scratch();
    const bin = join(d, "tmux"); writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
    expect(resolveTmux({ env: { [TMUX_BIN_ENV]: bin }, agendHome: d })).toEqual({ binary: bin, terminfo: null, source: "override", version: null });
  });

  it.each([
    ["a relative path", () => "tmux", /is not an absolute path/],
    ["a missing file", () => "/nonexistent/tmux", /is not a file/],
    ["a directory", (d: string) => d, /is not a file/],
    ["a file that is not executable", (d: string) => { const f = join(d, "tmux"); writeFileSync(f, "x"); chmodSync(f, 0o644); return f; }, /is not executable/],
  ])("%s is refused with what to do", (_why, make, reason) => {
    const d = scratch();
    expect(() => resolveTmux({ env: { [TMUX_BIN_ENV]: make(d) }, agendHome: d })).toThrow(TmuxUnavailableError);
    try { resolveTmux({ env: { [TMUX_BIN_ENV]: make(d) }, agendHome: d }); } catch (e) {
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
    const r = resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    const sha = createHash("sha256").update(readFileSync(p.bin)).digest("hex");
    expect(r).toEqual({ source: "bundled", version: "3.8", binary: join(p.agendHome, "tmux", `3.8-${sha.slice(0, 12)}`, "bin", "tmux"),
      terminfo: join(p.agendHome, "tmux", `3.8-${sha.slice(0, 12)}`, "share", "terminfo") });
    expect(createHash("sha256").update(readFileSync(r.binary)).digest("hex")).toBe(sha);
    expect(statSync(r.binary).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(r.terminfo!, "t", "tmux-256color"), "utf8")).toBe("terminfo");
    // A good copy is reused, not copied again; a copy that no longer matches the receipt is replaced.
    const before = statSync(r.binary).mtimeMs;
    resetTmuxResolution();
    expect(resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome }).binary).toBe(r.binary);
    expect(statSync(r.binary).mtimeMs).toBe(before);
    writeFileSync(r.binary, "#!/bin/sh\necho tampered\n");
    resetTmuxResolution();
    resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    expect(createHash("sha256").update(readFileSync(r.binary)).digest("hex")).toBe(sha);
  });

  it.each([
    ["this release pins none for the host", { pin: false }, /has no bundled tmux for linux-x64/],
    ["the package was not installed", { installed: false }, /is not installed or not verified/],
    ["the package has no receipt (not verified)", { receipt: false }, /is not installed or not verified/],
  ])("is refused, never PATH's tmux instead, when %s", (_why, opts, reason) => {
    const p = pkg(opts);
    expect(() => resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome })).toThrow(reason);
    expect(existsSync(join(p.agendHome, "tmux"))).toBe(false);
  });

  it("is refused when the copied bytes are not the receipt's (changed while copied): no copy is left to be trusted", () => {
    // The receipt is checked by size + mtime before the copy; its sha256 is checked on the copy. A receipt sha that the
    // file does not have stands for a file that changed between the two.
    const p = pkg({ receiptSha: "0".repeat(64) });
    expect(() => resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome }))
      .toThrow(/changed while it was being copied/);
    expect(() => resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome })).toThrow(TmuxUnavailableError);
    const dir = join(p.agendHome, "tmux");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);   // neither the destination nor a .tmp
  });
});

describe("on: socket, environment, config, attach", () => {
  it("the real home's socket is agend (never tmux's default); any other home keeps its isolated name", () => {
    expect(socketFor(true, null)).toBe(BUNDLED_TMUX_SOCKET);
    expect(socketFor(true, "agend-1a2b3c")).toBe(BUNDLED_TMUX_SOCKET);
    expect(socketFor(false, "agend-1a2b3c")).toBe("agend-1a2b3c");
    // Another home without a name of its own never falls back to the real home's (live) socket.
    expect(() => socketFor(false, null)).toThrow(TmuxUnavailableError);
  });

  it("tmuxSocket() is agend for the real home, never null; another home gets its isolated name", () => {
    // The real home is the one the password database names (paths.ts), so the answer is read from it; nothing runs.
    vi.stubEnv("AGEND_HOME", join(userInfo().homedir, ".agend"));
    expect(tmuxSocket()).toBe("agend");
    vi.stubEnv("AGEND_HOME", scratch());
    expect(tmuxSocket()).toMatch(/^agend-[0-9a-f]{6}$/);
  });

  it("the environment: bundled terminfo first, true colour, AGEND_TMUX for panes, no caller $TMUX / $TMUX_PANE", () => {
    const p = pkg();
    const env = tmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", TERMINFO_DIRS: "/opt/ti", PATH: "/usr/bin" },
      { env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    const r = resolveTmux({ env: {}, packageDir: p.dir, hostId: "linux-x64", agendHome: p.agendHome });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.TERMINFO_DIRS).toBe(`${r.terminfo}:/opt/ti`);
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.AGEND_TMUX).toBe(r.binary);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("tmuxEnvOption() is always { env } carrying the same environment", () => {
    const opt = tmuxEnvOption();
    expect(Object.keys(opt)).toEqual(["env"]);
    expect(opt.env.COLORTERM).toBe("truecolor");
    expect(opt.env.TMUX).toBeUndefined();
  });

  it("AgEnD's own config is written once and passed with -f (the user's ~/.tmux.conf is never read)", () => {
    const d = scratch();
    expect(tmuxConfArgs(d)).toEqual(["-f", join(d, "tmux", "agend-tmux.conf")]);
    expect(readFileSync(join(d, "tmux", "agend-tmux.conf"), "utf8")).toBe(AGEND_TMUX_CONF);
    expect(AGEND_TMUX_CONF).toMatch(/set -g default-terminal "tmux-256color"/);
    // A changed file is put back to AgEnD's.
    writeFileSync(join(d, "tmux", "agend-tmux.conf"), "set -g mouse off\n");
    resetTmuxResolution();
    tmuxConfArgs(d);
    expect(readFileSync(join(d, "tmux", "agend-tmux.conf"), "utf8")).toBe(AGEND_TMUX_CONF);
  });

  it("tmuxArgs() always prefixes this fleet's -L socket and AgEnD's -f config, ahead of the arguments", () => {
    const home = scratch();
    vi.stubEnv("AGEND_HOME", home);
    expect(tmuxArgs(["ls"])).toEqual(["-L", tmuxSocket(), "-f", join(home, "tmux", "agend-tmux.conf"), "ls"]);
  });

  it("agend attach is 'inside' only this fleet's tmux", () => {
    expect(insideFleetTmux(undefined, "agend")).toBe(false);
    expect(insideFleetTmux("/tmp/tmux-1000/agend,123,0", "agend")).toBe(true);
    expect(insideFleetTmux("/tmp/tmux-1000/agend-1a2b3c,9,1", "agend-1a2b3c")).toBe(true);
  });

  it("a $TMUX on another socket (the user's own tmux) is not inside: attaching from it is an ordinary attach", () => {
    expect(insideFleetTmux("/tmp/tmux-1000/default,123,0", "agend")).toBe(false);
    expect(insideFleetTmux("/tmp/tmux-1000/agend-1a2b3c,9,1", "agend")).toBe(false);
  });
});

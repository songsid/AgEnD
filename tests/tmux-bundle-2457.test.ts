/**
 * M-2457 PR A (docs/design/bundled-tmux.md §3, §6.1, §8): the bundled tmux's pins, packages and install-time proof.
 *  - tmux-sources.json is complete (every source has an https url and a sha256), jemalloc only on darwin;
 *  - the package manifest maps the tmux release onto semver, has no `bin` (never on PATH) and records the binary;
 *  - postinstall proves the pinned tmux (sha256, size, -V, a private-socket start/answer/kill) before accepting the
 *    install, writes the receipt, and refuses on any failure — npm then keeps the previous version;
 *  - no pin (nothing published yet, this PR): postinstall does nothing new.
 * The tmux here is a stand-in shell script that keeps its "server" in a file; no real tmux server is started.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { partsFor, readSources, srcDirName, TARGETS } from "../scripts/tmux/build-tmux.mjs";
import { tmuxManifest, tmuxSemver } from "../scripts/tmux/build-tmux-packages.mjs";

const require = createRequire(import.meta.url);
const LAUNCHER = join(process.cwd(), "launcher");
const bundle = require(join(LAUNCHER, "tmux-bundle.cjs"));
const HOST = { platform: "linux", arch: "x64", id: "linux-x64", glibc: "2.39", darwinRelease: null };
const PIN = "3.8.0";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("tmux-sources.json and the package manifest", () => {
  it("pins every source by https url and sha256; jemalloc links only on darwin", () => {
    const s = readSources();
    expect(s.tmux.version).toBe("3.8");
    for (const k of ["tmux", "libevent", "ncurses", "utf8proc", "jemalloc"]) {
      expect(s[k].url, k).toMatch(/^https:\/\//);
      expect(s[k].sha256, k).toMatch(/^[0-9a-f]{64}$/);
      expect(s[k].url, k).toContain(s[k].version);
    }
    expect(partsFor(s, "linux-x64")).not.toContain("jemalloc");
    expect(partsFor(s, "darwin-arm64")).toContain("jemalloc");
    expect(partsFor(s, "darwin-arm64")).toContain("utf8proc");
    expect(srcDirName("utf8proc", "2.12.0")).toBe("utf8proc-2.12.0");
    // The terminfo subset holds what panes and attaching terminals need, and the alias names a listed entry.
    for (const t of ["tmux-256color", "xterm-256color", "screen-256color", "kitty"]) expect(s.terminfo).toContain(t);
    expect(s.terminfoAliases?.["xterm-kitty"]).toBe("kitty");
  });

  it("refuses a pin file with a source that has no sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-src-")); roots.push(dir);
    const s = JSON.parse(readFileSync(join(process.cwd(), "scripts/release/tmux-sources.json"), "utf8"));
    delete s.ncurses.sha256;
    writeFileSync(join(dir, "s.json"), JSON.stringify(s));
    expect(() => readSources(join(dir, "s.json"))).toThrow(/ncurses needs/);
  });

  it.each([["3.8", undefined, "3.8.0"], ["3.7b", undefined, "3.7.2"], ["3.6a", undefined, "3.6.1"], ["3.8", "2", "3.8.0-agend.2"]])(
    "tmux %s (repack %s) is package version %s", (tmux, repack, want) => {
      expect(tmuxSemver(tmux, repack)).toBe(want);
      expect(bundle.SEMVER.test(want)).toBe(true);
    });

  it("a package: exact os/cpu, no bin (never on PATH), no libc (static), and the binary it holds", () => {
    for (const target of TARGETS) {
      const m = tmuxManifest(target, { tmux: "3.8", sha256: "a".repeat(64), size: 123 });
      expect(m.name).toBe(`@songsid/agend-tmux-${target}`);
      expect(m.os).toEqual([target.split("-")[0]]);
      expect(m.cpu).toEqual([target.split("-")[1]]);
      expect(m).not.toHaveProperty("bin");
      expect(m).not.toHaveProperty("libc");
      expect(m.agendTmux).toEqual({ tmux: "3.8", sha256: "a".repeat(64), size: 123 });
      expect(m.files).toContain("LICENSES/");
    }
  });

  it("THIRD_PARTY_NOTICES names every bundled component", () => {
    const notices = readFileSync(join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const name of ["tmux", "libevent", "ncurses", "utf8proc", "jemalloc"]) expect(notices, name).toMatch(new RegExp(`\\b${name}\\b`, "i"));
  });
});

/**
 * A stand-in tmux that refuses any call without `-L` (as the test guard does): `-V` prints $FAKE_V (default "tmux 3.8"); with `-L <sock>` it keeps the server as a file in
 * $FAKE_STATE, and like tmux leaves its socket file ($FAKE_STATE.dir/<sock>) behind after kill-server.
 * FAKE_FAIL=<command> makes that command fail; FAKE_STICKY=1 leaves the server up after kill-server.
 */
const FAKE_TMUX = `#!/bin/sh
[ "$1" = "-L" ] || { echo "no -L" >&2; exit 9; }
sock=$2; shift 2
if [ "$1" = "-V" ]; then echo "\${FAKE_V:-tmux 3.8}"; exit 0; fi
[ "$1" = "-f" ] && shift 2
cmd=$1
echo "$sock $cmd" >> "$FAKE_STATE.log"
[ "\${FAKE_FAIL:-}" = "$cmd" ] && { echo "$cmd: failed on purpose" >&2; exit 1; }
case "$cmd" in
  new-session) touch "$FAKE_STATE.$sock"; mkdir -p "$FAKE_STATE.dir"
    node -e 'require("net").createServer().listen(process.argv[1], () => process.exit(0))' "$FAKE_STATE.dir/$sock" ;;
  display-message) echo "$FAKE_STATE.dir/$sock" ;;
  has-session|capture-pane) [ -f "$FAKE_STATE.$sock" ] || { echo "no server running" >&2; exit 1; } ;;
  kill-server) [ -f "$FAKE_STATE.$sock" ] || exit 1; [ -n "\${FAKE_STICKY:-}" ] || rm -f "$FAKE_STATE.$sock" ;;
esac
exit 0
`;

/** A fixture @songsid/agend with this repo's launcher/, pinning the tmux package for HOST, and (optionally) that package. */
function fixture(opts: { pin?: string | null; tmux?: "ok" | "none" | "tampered" | "wrong-name" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend tmux-")); roots.push(root);
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  cpSync(LAUNCHER, join(pkg, "launcher"), { recursive: true });
  const pin = opts.pin === undefined ? PIN : opts.pin;
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@songsid/agend", version: "2.4.0", engines: { node: ">=22.14.0" },
    ...(pin ? { optionalDependencies: { [`@songsid/agend-tmux-${HOST.id}`]: pin } } : {}),
  }, null, 2) + "\n");
  const home = join(pkg, "node_modules", "@songsid", `agend-tmux-${HOST.id}`);
  if ((opts.tmux ?? "ok") !== "none") {
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(home, "share", "terminfo"), { recursive: true });
    const bin = join(home, "bin", "tmux");
    writeFileSync(bin, FAKE_TMUX);
    chmodSync(bin, 0o755);
    const buf = readFileSync(bin);
    writeFileSync(join(home, "package.json"), JSON.stringify({
      name: opts.tmux === "wrong-name" ? "@songsid/agend-tmux-other" : `@songsid/agend-tmux-${HOST.id}`, version: PIN,
      agendTmux: { tmux: "3.8", sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length },
    }));
    // Same size, same behaviour, other bytes: only the sha256 can tell.
    if (opts.tmux === "tampered") writeFileSync(bin, FAKE_TMUX.replace("failed on purpose", "FAILED ON PURPOSE"));
  }
  return { root, pkg, home, state: join(root, "server") };
}

let sockN = 0;
/** Postinstall in a child. The throwaway socket is named for the test guard (agend-test-*); production's is checked below. */
function postinstall(f: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  const tmuxDeps = { socket: `agend-test-verify-${process.pid}-${++sockN}` };
  const driver = `process.exit(require(${JSON.stringify(join(f.pkg, "launcher", "postinstall.cjs"))}).main({ launcherDir: ${JSON.stringify(join(f.pkg, "launcher"))}, host: ${JSON.stringify(HOST)}, versions: { node: "22.20.0", napi: 10 }, tmuxDeps: ${JSON.stringify(tmuxDeps)} }) || 0)`;
  return spawnSync(process.execPath, ["-e", driver], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, AGEND_HOME: f.root, AGEND_UPDATE_KEEPS_PREVIOUS: "", npm_command: "", FAKE_STATE: f.state, TMUX: "", ...env } });
}
const receipt = (f: ReturnType<typeof fixture>) => join(f.pkg, bundle.RECEIPT);
const sockets = (f: ReturnType<typeof fixture>) => existsSync(`${f.state}.log`) ? readFileSync(`${f.state}.log`, "utf8").trim().split("\n").map((l) => l.split(" ")[0]) : [];

describe("postinstall proves the bundled tmux before the install is accepted", () => {
  it("a good package: verified on a private socket, killed, and the receipt written", () => {
    const f = fixture();
    const r = postinstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("bundled tmux 3.8 verified");
    const rec = JSON.parse(readFileSync(receipt(f), "utf8"));
    expect(rec).toMatchObject({ receipt: 1, pinnedVersion: PIN, tmux: "3.8", platform: "linux", arch: "x64" });
    expect(rec.sha256).toBe(createHash("sha256").update(readFileSync(join(f.home, "bin", "tmux"))).digest("hex"));
    // Only its own throwaway socket — never "default", never AgEnD's "agend" — and nothing left running.
    const used = new Set(sockets(f));
    expect(used.size, [...used].join(",")).toBe(1);
    expect([...used][0]).toMatch(/^agend-test-verify-/);
    expect(existsSync(`${f.state}.${[...used][0]}`)).toBe(false);
    // The socket file tmux leaves behind is removed too, once nothing answers on it.
    expect(existsSync(join(`${f.state}.dir`, [...used][0]))).toBe(false);
    expect(bundle.readReceipt(f.pkg, { version: PIN })).not.toBeNull();
  });

  it.each([
    ["the binary differs from what the package declares", { tmux: "tampered" as const }, {}, /sha256 is not the one its package declares/],
    ["the package is not the pinned one", { tmux: "wrong-name" as const }, {}, /is not @songsid\/agend-tmux-linux-x64@3\.8\.0/],
    ["-V names another release", {}, { FAKE_V: "tmux 3.7b" }, /says 'tmux 3\.7b', not 'tmux 3\.8'/],
    ["the server does not start", {}, { FAKE_FAIL: "new-session" }, /new-session failed/],
    ["the server does not answer", {}, { FAKE_FAIL: "capture-pane" }, /capture-pane failed/],
    ["the server survives kill-server", {}, { FAKE_STICKY: "1" }, /still running after kill-server/],
  ])("refused when %s: exit 1, no receipt (npm keeps the previous version)", (_why, opts, env, reason) => {
    const f = fixture(opts);
    const r = postinstall(f, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AgEnD cannot be installed here/);
    expect(r.stderr).toMatch(reason);
    expect(existsSync(receipt(f))).toBe(false);
  });

  it("a failed check still kills its throwaway server", () => {
    const f = fixture();
    postinstall(f, { FAKE_FAIL: "capture-pane" });
    const sock = sockets(f)[0];
    expect(sockets(f).filter((s) => s === sock).length).toBeGreaterThan(2);
    expect(existsSync(`${f.state}.${sock}`)).toBe(false);
    expect(existsSync(join(`${f.state}.dir`, sock))).toBe(false);
  });

  it("a server that survives kill-server keeps its socket file (nothing is removed while it may answer)", () => {
    const f = fixture();
    postinstall(f, { FAKE_STICKY: "1" });
    expect(existsSync(join(`${f.state}.dir`, sockets(f)[0]))).toBe(true);
  });

  it("pinned but not installed (--omit=optional): the install goes on with a warning, no receipt", () => {
    const f = fixture({ tmux: "none" });
    const r = postinstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/bundled tmux .* was not installed/);
    expect(existsSync(receipt(f))).toBe(false);
  });

  it("no pin for this host (this release): nothing new happens", () => {
    const f = fixture({ pin: null });
    const r = postinstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/tmux/);
    expect(existsSync(`${f.state}.log`)).toBe(false);
    expect(existsSync(receipt(f))).toBe(false);
  });

  it("a receipt left by a previous install is removed first: a failed check never leaves an old one behind", () => {
    const f = fixture();
    expect(postinstall(f).status).toBe(0);
    expect(existsSync(receipt(f))).toBe(true);
    expect(postinstall(f, { FAKE_V: "tmux 3.4" }).status).toBe(1);
    expect(existsSync(receipt(f))).toBe(false);
  });

  it("a receipt is trusted only while it describes the file on disk", () => {
    const f = fixture();
    expect(postinstall(f).status).toBe(0);
    expect(bundle.readReceipt(f.pkg, { version: PIN })).not.toBeNull();
    expect(bundle.readReceipt(f.pkg, { version: "3.8.0-agend.1" })).toBeNull();
    utimesSync(join(f.home, "bin", "tmux"), new Date(), new Date(Date.now() + 5000));
    expect(bundle.readReceipt(f.pkg, { version: PIN })).toBeNull();
  });

  it("in production every call names its own throwaway socket agend-verify-<pid>, -V included", () => {
    const f = fixture();
    const calls: string[][] = [];
    const proved = bundle.verifyTmux(bundle.tmuxCandidate(f.pkg, { name: `@songsid/agend-tmux-${HOST.id}`, version: PIN }), { name: `@songsid/agend-tmux-${HOST.id}`, version: PIN }, {
      pid: 4242,
      spawnSync: (_file: string, args: string[]) => {
        calls.push(args);
        if (args[2] === "-V") return { status: 0, stdout: "tmux 3.8\n", stderr: "" };
        return { status: args.includes("has-session") && calls.some((c) => c.includes("kill-server")) ? 1 : 0, stdout: "", stderr: "" };
      },
    });
    expect(proved.ok, proved.reason).toBe(true);
    expect(calls.length).toBe(7);
    for (const c of calls) expect(c.slice(0, 2)).toEqual(["-L", "agend-verify-4242"]);
  });

  it("removes only its own socket file: a reported path with another name is left alone", () => {
    const f = fixture();
    const other = join(f.root, "default");
    spawnSync(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => process.exit(0))", other]);
    expect(existsSync(other)).toBe(true);
    const pin = { name: `@songsid/agend-tmux-${HOST.id}`, version: PIN };
    let killed = false;
    const proved = bundle.verifyTmux(bundle.tmuxCandidate(f.pkg, pin), pin, {
      pid: 7,
      spawnSync: (_file: string, args: string[]) => {
        if (args[2] === "-V") return { status: 0, stdout: "tmux 3.8\n", stderr: "" };
        if (args[2] === "display-message") return { status: 0, stdout: other + "\n", stderr: "" };
        if (args[2] === "kill-server") killed = true;
        return { status: args[2] === "has-session" && killed ? 1 : 0, stdout: "", stderr: "" };
      },
    });
    expect(proved.ok, proved.reason).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("pinnedTmux accepts only an exact version", () => {
    expect(bundle.pinnedTmux({ optionalDependencies: { "@songsid/agend-tmux-linux-x64": "3.8.0" } }, HOST)).toEqual({ name: "@songsid/agend-tmux-linux-x64", version: "3.8.0" });
    expect(bundle.pinnedTmux({ optionalDependencies: { "@songsid/agend-tmux-linux-x64": "^3.8.0" } }, HOST)).toBeNull();
    expect(bundle.pinnedTmux({ optionalDependencies: { "@songsid/agend-tmux-darwin-arm64": "3.8.0" } }, HOST)).toBeNull();
    expect(bundle.pinnedTmux({}, HOST)).toBeNull();
  });

  it("the bundled tmux never inherits the caller's $TMUX, and finds its own terminfo first", () => {
    const env = bundle.tmuxEnv({ terminfo: "/x/share/terminfo" }, { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1", LANG: "C" });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.TERMINFO_DIRS.split(":")[0]).toBe("/x/share/terminfo");
    expect(env.LC_CTYPE).toBe("C.UTF-8");
  });
});

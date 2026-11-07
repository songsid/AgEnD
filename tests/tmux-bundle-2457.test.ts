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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { partsFor, readSources, srcDirName, stripCommand, TARGETS } from "../scripts/tmux/build-tmux.mjs";
import { licenseFor, tmuxManifest, tmuxSemver } from "../scripts/tmux/build-tmux-packages.mjs";
import { lockMismatches, parseApkInfo, toolchainEnv } from "../scripts/tmux/toolchain.mjs";

const require = createRequire(import.meta.url);
const LAUNCHER = join(process.cwd(), "launcher");
const bundle = require(join(LAUNCHER, "tmux-bundle.cjs"));
const HOST = { platform: "linux", arch: "x64", id: "linux-x64", glibc: "2.39", darwinRelease: null };
const PIN = "3.8.0";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// A bundled tmux package found broken after publish can never be pinned again (design §3: darwin-arm64 3.8.0 linked
// jemalloc, and its server crashed on the real Mac). Checks AgEnD's own package.json — vacuous until it pins the tmux.
const NEVER_PIN: Record<string, string[]> = { "@songsid/agend-tmux-darwin-arm64": ["3.8.0"] };
describe("AgEnD's own package.json never pins a bundled tmux known to be broken", () => {
  it("no pinned @songsid/agend-tmux-* version is on the NEVER_PIN list", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { optionalDependencies?: Record<string, string> };
    const pins = Object.entries(manifest.optionalDependencies ?? {}).filter(([n]) => n.startsWith("@songsid/agend-tmux-"));
    for (const [n, v] of pins) expect(NEVER_PIN[n] ?? [], `${n}@${v}`).not.toContain(v);
    // The rule itself refuses the broken pin (the check is not vacuous by construction).
    const bad = { "@songsid/agend-tmux-darwin-arm64": "3.8.0" };
    expect(Object.entries(bad).some(([n, v]) => (NEVER_PIN[n] ?? []).includes(v))).toBe(true);
  });
});

// M-2457 C-4: the bundled tmux is on, with no PATH fallback — every target is pinned, exactly, to the tmux release in
// tmux-sources.json (`3.8.0`, or a repack `3.8.0-agend.N`).
describe("AgEnD's own package.json pins the bundled tmux for every target", () => {
  it("all four, exact versions of the pinned tmux release", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { optionalDependencies: Record<string, string> };
    const pins = Object.entries(manifest.optionalDependencies).filter(([n]) => n.startsWith("@songsid/agend-tmux-"));
    expect(pins.map(([n]) => n).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map(t => `@songsid/agend-tmux-${t}`));
    const [maj, min] = readSources().tmux.version.split(".");
    for (const [n, v] of pins) expect(v, n).toMatch(new RegExp(`^${maj}\\.${min}\\.0(-agend\\.[1-9]\\d*)?$`));
  });
});

describe("tmux-sources.json and the package manifest", () => {
  it("pins every source by https url and sha256; no jemalloc anywhere (§3)", () => {
    const s = readSources();
    expect(s.tmux.version).toBe("3.8");
    expect((s as unknown as Record<string, unknown>).jemalloc).toBeUndefined();
    for (const k of ["tmux", "libevent", "ncurses", "utf8proc"] as const) {
      expect(s[k].url, k).toMatch(/^https:\/\//);
      expect(s[k].sha256, k).toMatch(/^[0-9a-f]{64}$/);
      expect(s[k].url, k).toContain(s[k].version);
    }
    expect(partsFor(s, "darwin-arm64")).toEqual(["tmux", "libevent", "ncurses", "utf8proc"]);
    expect(partsFor(s, "darwin-x64")).toEqual(["tmux", "libevent", "ncurses", "utf8proc"]);
    expect(partsFor(s, "linux-x64")).toEqual(["tmux", "libevent", "ncurses", "utf8proc", "musl"]);
    expect(srcDirName("utf8proc", "2.12.0")).toBe("utf8proc-2.12.0");
    // The terminfo subset holds what panes and attaching terminals need, and the alias names a listed entry.
    for (const t of ["tmux-256color", "xterm-256color", "screen-256color", "kitty"]) expect(s.terminfo).toContain(t);
    expect(s.terminfoAliases?.["xterm-kitty"]).toBe("kitty");
  });

  it("the toolchain is locked: the Alpine image by digest with exact package versions, and an explicit Xcode", () => {
    const s = readSources();
    expect(s.toolchain.alpine.image).toMatch(/^alpine:3\.20@sha256:[0-9a-f]{64}$/);
    expect(s.toolchain.alpine.release).toMatch(/^3\.20\.\d+$/);
    for (const name of ["gcc", "binutils", "musl", "musl-dev", "make", "linux-headers"]) expect(s.toolchain.alpine.packages[name], name).toMatch(/-r\d+$/);
    // The licence pin and the linked libc agree.
    expect(s.toolchain.alpine.packages.musl.startsWith(`${s.musl.version}-`)).toBe(true);
    expect(s.toolchain.darwin.developerDir).toBe(`/Applications/Xcode_${s.toolchain.darwin.xcode}.app/Contents/Developer`);
    expect(s.toolchain.darwin.xcodeBuild).toMatch(/^\w+$/);
  });

  it("macOS strips with the LOCKED Xcode's strip, run under the locked DEVELOPER_DIR — never the runner's selection", () => {
    const locked = readSources().toolchain.darwin.developerDir;
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", ...toolchainEnv("darwin-arm64") };
    expect(env.DEVELOPER_DIR).toBe(locked);
    const seen: Array<Record<string, string | undefined>> = [];
    // xcrun answers from whichever developer dir its environment selects (an inert stand-in).
    const xcrun = (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      seen.push(opts.env);
      return `${opts.env.DEVELOPER_DIR ?? "/Applications/Xcode_26.3.app/Contents/Developer"}/Toolchains/XcodeDefault.xctoolchain/usr/bin/strip\n`;
    };
    expect(stripCommand("darwin-arm64", env, xcrun)).toEqual({ cmd: `${locked}/Toolchains/XcodeDefault.xctoolchain/usr/bin/strip`, args: ["-x"] });
    expect(seen[0]!.DEVELOPER_DIR).toBe(locked);
    // A strip from another Xcode (the runner's own selection) is refused, and so is a build with no lock in its env.
    expect(() => stripCommand("darwin-arm64", env, () => "/Applications/Xcode_26.3.app/Contents/Developer/usr/bin/strip\n")).toThrow(/outside the locked Xcode/);
    expect(() => stripCommand("darwin-x64", { PATH: "/usr/bin" }, xcrun)).toThrow(/no locked DEVELOPER_DIR/);
    expect(stripCommand("linux-x64", {}, xcrun)).toEqual({ cmd: "strip", args: [] });
  });

  it("a toolchain that drifted from the lock is named, version by version", () => {
    const installed = parseApkInfo("gcc-13.2.1_git20240309-r1\nmusl-1.2.5-r5\nlibstdc++-dev-13.2.1_git20240309-r1\nbusybox-1.36.1-r31\n");
    expect(installed["libstdc++-dev"]).toBe("13.2.1_git20240309-r1");
    expect(lockMismatches({ gcc: "13.2.1_git20240309-r1" }, installed)).toEqual([]);
    expect(lockMismatches({ gcc: "13.2.1_git20240309-r1", musl: "1.2.5-r4", make: "4.4.1-r2" }, installed))
      .toEqual(["musl: want 1.2.5-r4, have 1.2.5-r5", "make: want 4.4.1-r2, have none"]);
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

  // Fable #3312 F2: the licence is exactly the linked parts' (no jemalloc BSD-2-Clause left on darwin).
  it("a package's licence is its linked parts' licences, each once", () => {
    const s = readSources();
    for (const target of TARGETS) {
      const want = [...new Set(partsFor(s, target).flatMap(p => String(s[p as keyof typeof s] && (s as any)[p].license).split(" AND ")))].join(" AND ");
      expect(tmuxManifest(target, { tmux: "3.8", sha256: "a".repeat(64), size: 1 }).license, target).toBe(want);
      expect(licenseFor(target), target).not.toContain("BSD-2-Clause");
    }
    expect(licenseFor("linux-x64")).toBe("ISC AND BSD-3-Clause AND X11 AND MIT AND Unicode-3.0");
    expect(licenseFor("darwin-arm64")).toBe("ISC AND BSD-3-Clause AND X11 AND MIT AND Unicode-3.0");
  });

  it("THIRD_PARTY_NOTICES names every bundled component", () => {
    const notices = readFileSync(join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const name of ["tmux", "libevent", "ncurses", "utf8proc"]) expect(notices, name).toMatch(new RegExp(`\\b${name}\\b`, "i"));
    expect(notices).not.toMatch(/\bjemalloc\b/i);   // no longer linked (§3)
  });
});

/**
 * A stand-in tmux that refuses any call without `-L` (as the test guard does). With `-L <sock>`:
 *  - new-session requires the pane program in argv form (`/bin/sh -c …`: tmux execs it directly, no login shell), starts a
 *    real background "server" process (its pid in $FAKE_STATE.<sock>.pid) and, like tmux, a socket file
 *    $FAKE_STATE.dir/<sock> that stays behind after kill-server;
 *  - display-message prints "<pid> <socket path>"; capture-pane prints the pane program's mark; has-session answers
 *    while the server process lives; kill-server ends it.
 * FAKE_V: the -V answer. FAKE_FAIL=<command> fails that command. FAKE_STICKY=1: kill-server leaves the server running.
 * FAKE_NOMARK=1: the pane shows nothing.
 */
const FAKE_TMUX = `#!/bin/sh
[ "$1" = "-L" ] || { echo "no -L" >&2; exit 9; }
sock=$2; shift 2
if [ "$1" = "-V" ]; then echo "\${FAKE_V:-tmux 3.8}"; exit 0; fi
[ "$1" = "-f" ] && shift 2
cmd=$1
printf '%s\\n' "$sock $*" >> "$FAKE_STATE.log"
[ "\${FAKE_FAIL:-}" = "$cmd" ] && { echo "$cmd: failed on purpose" >&2; exit 1; }
pidf="$FAKE_STATE.$sock.pid"
alive() { [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; }
case "$cmd" in
  new-session)
    case "$*" in *" /bin/sh -c "*) ;; *) echo "no pane program in argv form: $*" >&2; exit 7 ;; esac
    sleep 300 </dev/null >/dev/null 2>&1 &
    echo $! > "$pidf"
    mkdir -p "$FAKE_STATE.dir"
    node -e 'require("net").createServer().listen(process.argv[1], () => process.exit(0))' "$FAKE_STATE.dir/$sock" ;;
  display-message) echo "$(cat "$pidf") $FAKE_STATE.dir/$sock" ;;
  capture-pane) alive || { echo "no server running" >&2; exit 1; }; [ -n "\${FAKE_NOMARK:-}" ] || echo "agend-verify-ok" ;;
  has-session) alive || { echo "no server running on $sock" >&2; exit 1; } ;;
  kill-server) alive || exit 1; [ -n "\${FAKE_STICKY:-}" ] || kill "$(cat "$pidf")" ;;
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
  const tmuxDeps = { socket: `agend-test-verify-${process.pid}-${++sockN}`, exitWaitMs: 1500 };
  const driver = `process.exit(require(${JSON.stringify(join(f.pkg, "launcher", "postinstall.cjs"))}).main({ launcherDir: ${JSON.stringify(join(f.pkg, "launcher"))}, host: ${JSON.stringify(HOST)}, versions: { node: "22.20.0", napi: 10 }, tmuxDeps: ${JSON.stringify(tmuxDeps)} }) || 0)`;
  return spawnSync(process.execPath, ["-e", driver], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, AGEND_HOME: f.root, AGEND_UPDATE_KEEPS_PREVIOUS: "", npm_command: "", FAKE_STATE: f.state, TMUX: "", ...env } });
}
const receipt = (f: ReturnType<typeof fixture>) => join(f.pkg, bundle.RECEIPT);
const calls = (f: ReturnType<typeof fixture>) => existsSync(`${f.state}.log`) ? readFileSync(`${f.state}.log`, "utf8").trim().split("\n") : [];
const sockets = (f: ReturnType<typeof fixture>) => calls(f).map((l) => l.split(" ")[0]);
const serverPid = (f: ReturnType<typeof fixture>, sock: string) => Number(readFileSync(`${f.state}.${sock}.pid`, "utf8"));
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterAll(() => {
  // Any stand-in server a refused proof left running (FAKE_STICKY) goes with the fixtures.
  for (const r of roots) for (const f of existsSync(r) ? readdirSync(r) : []) {
    if (f.endsWith(".pid")) try { process.kill(Number(readFileSync(join(r, f), "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
});

describe("postinstall proves the bundled tmux before the install is accepted", () => {
  it("a good package: verified on a private socket, the server positively gone, its socket file removed, the receipt written", () => {
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
    const sock = [...used][0];
    expect(sock).toMatch(/^agend-test-verify-/);
    expect(pidAlive(serverPid(f, sock))).toBe(false);
    expect(existsSync(join(`${f.state}.dir`, sock))).toBe(false);
    expect(bundle.readReceipt(f.pkg, { version: PIN })).not.toBeNull();
  });

  it("the pane runs a fixed program in argv form, never the installing user's (login) shell", () => {
    const f = fixture();
    // A hostile account setup: $SHELL that exits at once and startup files a shell would read.
    const marker = join(f.root, "PROFILE-RAN");
    writeFileSync(join(f.root, "rc"), `touch ${marker}; exit 1\n`);
    const r = postinstall(f, { SHELL: "/bin/false", ENV: join(f.root, "rc"), BASH_ENV: join(f.root, "rc") });
    expect(r.status, r.stderr).toBe(0);
    const ns = calls(f).find((l) => / new-session /.test(l))!;
    expect(ns).toMatch(/ -- | \/bin\/sh -c printf/);
    expect(existsSync(marker)).toBe(false);
    expect(bundle.PANE_ARGV.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    const env = bundle.tmuxEnv({ terminfo: "/x" }, { SHELL: "/bin/zsh", ENV: "/a", BASH_ENV: "/b" });
    expect(env.SHELL).toBe("/bin/sh");
    expect(env.ENV).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
  });

  it.each([
    ["the binary differs from what the package declares", { tmux: "tampered" as const }, {}, /sha256 is not the one its package declares/],
    ["the package is not the pinned one", { tmux: "wrong-name" as const }, {}, /is not @songsid\/agend-tmux-linux-x64@3\.8\.0/],
    ["-V names another release", {}, { FAKE_V: "tmux 3.7b" }, /says 'tmux 3\.7b', not 'tmux 3\.8'/],
    ["the server does not start", {}, { FAKE_FAIL: "new-session" }, /new-session failed/],
    ["the server does not say who it is", {}, { FAKE_FAIL: "display-message" }, /display-message failed/],
    ["the server does not answer", {}, { FAKE_FAIL: "capture-pane" }, /capture-pane failed/],
    ["the pane program's output never shows", {}, { FAKE_NOMARK: "1" }, /never showed the pane program's output/],
    ["the server survives kill-server", {}, { FAKE_STICKY: "1" }, /still running after kill-server/],
  ])("refused when %s: exit 1, no receipt (npm keeps the previous version)", (_why, opts, env, reason) => {
    const f = fixture(opts);
    const r = postinstall(f, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AgEnD cannot be installed here/);
    expect(r.stderr).toMatch(reason);
    expect(existsSync(receipt(f))).toBe(false);
  });

  it("a failed check still asks its throwaway server to go, but removes nothing it has not seen exit", () => {
    const f = fixture();
    postinstall(f, { FAKE_FAIL: "capture-pane" });
    const sock = sockets(f)[0];
    expect(calls(f).filter((l) => l === `${sock} kill-server`).length).toBe(1);
    expect(pidAlive(serverPid(f, sock))).toBe(false);
    expect(existsSync(join(`${f.state}.dir`, sock))).toBe(true);
  });

  it("a server that survives kill-server keeps its socket file, and the refusal names it", () => {
    const f = fixture();
    const r = postinstall(f, { FAKE_STICKY: "1" });
    const sock = sockets(f)[0];
    expect(existsSync(join(`${f.state}.dir`, sock))).toBe(true);
    expect(r.stderr).toContain(`server pid ${serverPid(f, sock)}`);
    expect(r.stderr).toContain(`socket ${join(`${f.state}.dir`, sock)} left in place`);
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

/**
 * The proof's end-of-server rule, against a REAL socket that stays open (an owned listener in this process) and a
 * scripted tmux: an unknown observation never counts as "gone" and never unlinks; only the passing control does.
 */
describe("verifyTmux: an unknown observation is never taken for the server's exit", () => {
  type R = { status: number | null; stdout: string; stderr: string; error?: { code: string }; signal?: string };
  const PINV = { name: `@songsid/agend-tmux-${HOST.id}`, version: PIN };
  async function scenario(opts: { afterKill?: Partial<R>; gone?: (pid: number) => boolean; idPath?: (dir: string, sock: string) => string; swapAfterKill?: boolean; chmodAfterKill?: boolean }) {
    const f = fixture();
    const sock = "agend-verify-4242";
    const dir = mkdtempSync(join(tmpdir(), "agend-sock-")); roots.push(dir);
    const path = join(dir, sock);
    const server = createServer().listen(path);
    await new Promise((res) => server.once("listening", res));
    const seen: string[][] = [];
    let killed = false;
    const proved = bundle.verifyTmux(bundle.tmuxCandidate(f.pkg, PINV), PINV, {
      pid: 4242, exitWaitMs: 200,
      processGone: opts.gone ?? (() => killed),
      spawnSync: (_file: string, args: string[]): R => {
        seen.push(args);
        const c = args[2];
        if (c === "-V") return { status: 0, stdout: "tmux 3.8\n", stderr: "" };
        if (c === "display-message") return { status: 0, stdout: `4321 ${(opts.idPath ?? (() => path))(dir, sock)}\n`, stderr: "" };
        if (c === "capture-pane") return { status: 0, stdout: "agend-verify-ok\n", stderr: "" };
        if (c === "kill-server") {
          killed = true;
          // Someone else's socket now sits at that path (a new inode): it is not the one this proof saw exit.
          if (opts.swapAfterKill) { rmSync(path); spawnSync(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => process.exit(0))", path]); }
          // The same inode, changed since the proof saw it: only the change time tells (an inode number can be reused).
          if (opts.chmodAfterKill) { const before = statSync(path).ctimeMs; while (statSync(path).ctimeMs === before) chmodSync(path, (statSync(path).mode & 0o777) ^ 0o020); }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (c === "has-session" && killed) return { status: 1, stdout: "", stderr: "no server running", ...opts.afterKill };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const left = existsSync(path);
    const answers = await new Promise<boolean>((res) => { const c = connect(path); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false)); });
    await new Promise((res) => server.close(res));
    return { proved, left, answers, seen };
  }

  it("passing control: the pid gone and a clean 'no server' — accepted, its own socket file removed", async () => {
    const r = await scenario({});
    expect(r.proved.ok, r.proved.reason).toBe(true);
    expect(r.left).toBe(false);
    // Every call names the throwaway socket agend-verify-<pid>, -V included; the pane program is argv-form.
    for (const c of r.seen) expect(c.slice(0, 2)).toEqual(["-L", "agend-verify-4242"]);
    expect(r.seen.find((c) => c.includes("new-session"))!.slice(-3)).toEqual(bundle.PANE_ARGV);
  });

  it.each([
    ["has-session timed out", { status: null, error: { code: "ETIMEDOUT" } }, /could not be confirmed \(has-session: ETIMEDOUT\)/],
    ["has-session was killed by a signal", { status: null, signal: "SIGKILL" }, /could not be confirmed \(has-session: signal SIGKILL\)/],
    ["has-session could not run", { status: null, error: { code: "EACCES" } }, /could not be confirmed \(has-session: EACCES\)/],
    ["the socket still answers", { status: 0 }, /still answering after kill-server/],
    ["has-session exited 2 (not tmux's 'no server')", { status: 2, stderr: "usage" }, /could not be confirmed \(has-session: exit 2: usage\)/],
    ["has-session exited 124 (a wrapper's timeout code)", { status: 124 }, /could not be confirmed \(has-session: exit 124[:)]/],
  ])("refused when %s — and the still-open socket is left in place", async (_why, afterKill, reason) => {
    const r = await scenario({ afterKill });
    expect(r.proved.ok).toBe(false);
    expect(r.proved.reason).toMatch(reason);
    expect(r.proved.reason).toMatch(/server pid 4321, socket .* left in place/);
    expect(r.left).toBe(true);
    expect(r.answers).toBe(true);
  });

  it("refused when the recorded server pid never exits — nothing unlinked", async () => {
    const r = await scenario({ gone: () => false });
    expect(r.proved.ok).toBe(false);
    expect(r.proved.reason).toMatch(/server \(pid 4321\) was still running after kill-server/);
    expect(r.left).toBe(true);
  });

  it("refused when the server names a socket that is not this run's — nothing unlinked", async () => {
    const r = await scenario({ idPath: (dir) => join(dir, "default") });
    expect(r.proved.ok).toBe(false);
    expect(r.proved.reason).toMatch(/did not say which process and socket it is/);
    expect(r.left).toBe(true);
  });

  it("accepted, but a socket file that is not the one it created (another inode at that path) is left alone", async () => {
    const r = await scenario({ swapAfterKill: true });
    expect(r.proved.ok, r.proved.reason).toBe(true);
    expect(r.left).toBe(true);
  });

  it("accepted, but a socket file changed since the proof saw it (same inode, new change time) is left alone", async () => {
    const r = await scenario({ chmodAfterKill: true });
    expect(r.proved.ok, r.proved.reason).toBe(true);
    expect(r.left).toBe(true);
  });

  it("processGone: this process is not gone; a reaped child is", () => {
    expect(bundle.processGone(process.pid)).toBe(false);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(bundle.processGone(Number(child.stdout))).toBe(true);
  });
});

describe("the darwin build", () => {
  // §3: the statically linked jemalloc 5.3.0 crashed the macOS tmux server on darwin-x64 (dry runs) and on darwin-arm64
  // (the real Mac, C-4 leg M). Both Macs use the system allocator; configure is told so explicitly, or it would look for
  // a jemalloc itself and could link a runner's Homebrew dylib.
  it("never links jemalloc: no such part, and --disable-jemalloc on macOS", () => {
    const src = readFileSync(join(process.cwd(), "scripts", "tmux", "build-tmux.mjs"), "utf8");
    expect(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].map(t => partsFor(readSources(), t).includes("jemalloc" as never))).toEqual([false, false, false, false]);
    expect(src).toContain('if (darwin) tmuxArgs.push("--disable-jemalloc");');
    expect(src).not.toContain("--enable-jemalloc");
  });

  it("a darwin build is reproducible: object paths relative in the debug map, ar member dates zeroed", () => {
    // ld64 hashes the output (debug map included) into LC_UUID, which strip keeps; the second build runs elsewhere.
    const src = readFileSync(join(process.cwd(), "scripts", "tmux", "build-tmux.mjs"), "utf8");
    expect(src).toContain("LDFLAGS: `-L${deps}/lib${darwin ? ` -Wl,-oso_prefix,${work}/` : \"\"}`");
    expect(src).toMatch(/darwin \? \{ MACOSX_DEPLOYMENT_TARGET: "11\.0", ZERO_AR_DATE: "1" \}/);
  });
});

describe("verifyTmux: the wait for the server's exit runs on a monotonic clock (alpha CI run 42287645555)", () => {
  it("a wall clock that steps forward mid-wait does not cut the wait short: a server that takes a few checks to go passes", () => {
    const f = fixture();
    const PINV = { name: `@songsid/agend-tmux-${HOST.id}`, version: PIN };
    const dir = mkdtempSync(join(tmpdir(), "agend-sock-")); roots.push(dir);
    const sock = "agend-verify-4343";
    const path = join(dir, sock);
    // A socket file for the identity check (no server needs to listen: the proof only stats it).
    spawnSync(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => process.exit(0))", path]);
    let killed = false, checks = 0, t = Date.now();
    const realNow = Date.now;
    Date.now = () => (t += 60_000);          // every read of the wall clock is a minute later
    try {
      const proved = bundle.verifyTmux(bundle.tmuxCandidate(f.pkg, PINV), PINV, {
        pid: 4343, exitWaitMs: 2000,
        processGone: () => killed && ++checks > 3,   // gone only on the fourth look after kill-server
        spawnSync: (_file: string, args: string[]) => {
          const c = args[2];
          if (c === "-V") return { status: 0, stdout: "tmux 3.8\n", stderr: "" };
          if (c === "display-message") return { status: 0, stdout: `4321 ${path}\n`, stderr: "" };
          if (c === "capture-pane") return { status: 0, stdout: "agend-verify-ok\n", stderr: "" };
          if (c === "kill-server") { killed = true; return { status: 0, stdout: "", stderr: "" }; }
          if (c === "has-session" && killed) return { status: 1, stdout: "", stderr: "no server running" };
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(proved).toMatchObject({ ok: true });
      expect(checks).toBeGreaterThanOrEqual(4);   // the loop looked until it was gone, then confirmed once more
    } finally { Date.now = realNow; }
  });
});

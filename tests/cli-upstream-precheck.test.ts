/**
 * The daily upstream-CLI precheck (scripts/manual/cli-upstream-precheck/):
 * - manifest.json is what the detectors' source says now — a detector literal added, changed or removed in src/ without
 *   rebuilding it fails here;
 * - precheck.py cannot run anything or reach the network (no such import), and its verdict follows its rules on small
 *   synthetic artifacts in every format it reads (a file, a .tgz, a .zip, a gzip file, a directory).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, SURFACES, buildManifest, manifestKeys, regexRuns, surfaceOf, type Manifest } from "../scripts/manual/cli-upstream-precheck/build-manifest.js";

const DIR = join(process.cwd(), "scripts/manual/cli-upstream-precheck");
const PRECHECK = join(DIR, "precheck.py");
const BACKENDS = ["agy", "claude", "codex", "grok", "kiro-cli", "muse", "opencode"];
const committed = (): Manifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

describe("manifest.json is the detectors' source (drift)", () => {
  it("matches what the source produces now — rebuild with build-manifest.ts when this fails", () => {
    expect(manifestKeys(committed())).toEqual(manifestKeys(buildManifest()));
  });
  it("a detector literal the source has and the manifest lacks is caught", () => {
    const m = committed();
    const without = structuredClone(m);
    without.backends.claude!.literals = without.backends.claude!.literals.filter((l) => l.text !== "Do you want to proceed");
    expect(manifestKeys(without)).not.toEqual(manifestKeys(buildManifest()));
  });
  it("covers all seven backends, each with literals on its known surfaces", () => {
    const m = committed();
    expect(Object.keys(m.backends).sort()).toEqual(BACKENDS);
    for (const b of BACKENDS) {
      expect(m.backends[b]!.literals.length, b).toBeGreaterThanOrEqual(10);
      for (const l of m.backends[b]!.literals) expect(SURFACES, `${b} ${l.text}`).toContain(l.surface);
    }
  });
  it.each([
    ["claude", "Do you want to proceed", "approval"],
    ["claude", "Yes, I trust this folder", "trust"],
    ["claude", "Resume from summary", "resume"],
  ])("%s has %j on its %s surface (read from a regex)", (b, text, surface) => {
    const l = committed().backends[b]!.literals.find((x) => x.text === text);
    expect([l?.surface, l?.kind]).toEqual([surface, "regex"]);
  });
  it("never keeps AgEnD's own words: entry descriptions/messages, t() and logger arguments", () => {
    const all = Object.values(committed().backends).flatMap((v) => v.literals);
    const claude = readFileSync(join(process.cwd(), "src/backend/claude-code.ts"), "utf8");
    const own = [...claude.matchAll(/description:\s*"([^"]{12,})"/g)].map((m) => m[1]!);
    expect(own.length).toBeGreaterThan(3);
    for (const d of own) expect(all.some((l) => l.text === d), d).toBe(false);
  });
});

describe("the regex reader", () => {
  it.each([
    [String.raw`^[ \t]*[❯›][ \t]*1\.[ \t]*Resume from summary \((?:instant, )?recommended\)`, ["Resume from summary"]],
    [String.raw`^[ \t]*Do you want to proceed\?[ \t]*$`, ["Do you want to proceed"]],
    [String.raw`No, maybe later with \/terminal-setup`, ["No, maybe later with /terminal-setup"]],
    [String.raw`colou?r is here now`, ["r is here now"]],
    [String.raw`(?<name>x) Yes, I trust this folder|Esc to cancel`, ["Yes, I trust this folder", "Esc to cancel"]],
  ])("%s → %j", (src, runs) => { expect(regexRuns(src)).toEqual(runs); });
  it("names a surface from the declaration when sources.json does not", () => {
    expect([surfaceOf(["TRUST_TITLE"]), surfaceOf(["getErrorPatterns"]), surfaceOf(["x"], { x: "exit" }), surfaceOf(["helper"])])
      .toEqual(["trust", "error", "exit", "other"]);
  });
});

describe("precheck.py compares prompt-like strings as a release would show them", () => {
  it.each([
    ["minified names inside ${…} are not compared", "retrying in ${(Pe/1000).toFixed(1)}s", "retrying in ${}s"],
    ["a string table's next header byte (Bun/JSC) is not compared", "Yes, and always allow access to 9", "Yes, and always allow access"],
    ["a native binary's neighbour string (Rust/Go: no separator) is cut at the sentence end", "press R to continue here.retry Forking", "press R to continue here."],
    ["…and after a colon run straight into the next string", "rate limit reached:Please try a shorter message.", "rate limit reached:"],
    ["…and where a header byte glues two strings with no punctuation (Go)", "Yes, proceednDo you trust the contents", "Yes,"],
    ["…the same pair without the byte reads the same", "Yes, proceedDo you trust the contents", "Yes,"],
    ["a neighbour past the 60-character cap never moves the cut (grok)", "usage limit reachedstatus 401unauthorizedinvalid_request_errorCompaction failed", "usage limit reachedstatus 401unauthorizedinvalid_request_err"],
    ["a prompt itself is kept", "Do you want to proceed? (y/n)", "Do you want to proceed?"],
  ])("%s", (_label, raw, key) => {
    const out = execFileSync("python3", ["-I", "-c", `import sys; sys.argv=["x"]; sys.path.insert(0, ${JSON.stringify(DIR)}); import precheck; print(precheck.normalize(sys.stdin.buffer.read()))`], { input: raw, encoding: "utf8" });
    expect(out.trimEnd()).toBe(key);
  });
});

describe("precheck.py is static by construction", () => {
  it("imports nothing that runs a program or opens a connection", () => {
    const src = readFileSync(PRECHECK, "utf8");
    expect(src.match(/^\s*(?:import|from)\s+(\S+)/gm)!.map((l) => l.trim().split(/\s+/)[1]).sort())
      .toEqual(["bisect", "gzip", "json", "os", "re", "sys", "tarfile", "zipfile"]);
    expect(src).not.toMatch(/subprocess|socket|urllib|http\.|os\.system|os\.exec|os\.spawn|popen|ctypes|extractall|\.extract\(|__import__|eval\(|exec\(/);
  });
});

// ── the verdict, on synthetic artifacts ──

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-precheck-")); dirs.push(d); return d; };
const LITS = [
  { text: "Do you trust the files in this folder", kind: "string", surface: "trust", file: "src/x.ts", line: 1, symbol: "TRUST" },
  { text: "esc to interrupt now", kind: "regex", surface: "idle-busy", file: "src/x.ts", line: 2, symbol: "getBusyPattern" },
  { text: "Rate limited, retrying soon", kind: "regex", surface: "error", file: "src/x.ts", line: 3, symbol: "getErrorPatterns" },
  { text: "Only AgEnD says this sentence", kind: "string", surface: "other", file: "src/x.ts", line: 4, symbol: "helper" },
];
function manifestFile(d: string): string {
  const p = join(d, "manifest.json");
  writeFileSync(p, JSON.stringify({ format: 1, source: "test", backends: { fake: { literals: LITS } } }));
  return p;
}
const pad = (n: number) => "\0".repeat(n);
const OLD = `head${pad(10)}Do you trust the files in this folder${pad(10)}esc to interrupt now${pad(10)}Rate limited, retrying soon${pad(10)}esc to interrupt now${pad(8000)}tail`;
function run(old: string, neu: string, m: string): { verdict: string; out: string } {
  const out = execFileSync("python3", ["-I", PRECHECK, "fake", old, neu, "--manifest", m], { encoding: "utf8" });
  return { verdict: out.trim().split("\n").at(-1)!, out };
}
function pair(neu: string): { verdict: string; out: string } {
  const d = scratch();
  writeFileSync(join(d, "old.bin"), OLD);
  writeFileSync(join(d, "new.bin"), neu);
  return run(join(d, "old.bin"), join(d, "new.bin"), manifestFile(d));
}

describe("precheck.py's verdict", () => {
  it("the same text: NONE (the literal only AgEnD has is not the CLI's, so its absence is nothing)", () => {
    expect(pair(OLD).verdict).toBe("PRECHECK: NONE");
  });
  it("a detector literal the old release had is gone: MAJOR, naming it and its surface", () => {
    const r = pair(OLD.replace("Rate limited, retrying soon", "Rate limit hit, retrying"));
    expect(r.verdict).toBe("PRECHECK: MAJOR");
    expect(r.out).toMatch(/REASON: 1 detector literal\(s\) missing: \[error\] "Rate limited, retrying soon"/);
  });
  it("only a count changed: MINOR", () => {
    expect(pair(OLD.replace("tail", `esc to interrupt now${pad(4)}tail`)).verdict).toBe("PRECHECK: MINOR");
  });
  it("a new prompt-like string next to a known detector literal: MAJOR, on that literal's surface", () => {
    const r = pair(OLD.replace("head", `head${pad(4)}Do you want to share this folder with everyone?${pad(4)}`));
    expect(r.verdict).toBe("PRECHECK: MAJOR");
    expect(r.out).toMatch(/\[[a-z,-]*trust[a-z,-]*\] "Do you want to share this folder with everyone\?"/);
  });
  it("a new prompt-like string far from every known literal: MINOR", () => {
    const r = pair(`${OLD}${pad(20000)}Do you want to enable the experimental garden?`);
    expect([r.verdict, /away from known literals/.test(r.out)]).toEqual(["PRECHECK: MINOR", true]);
  });
  it("an old artifact with almost none of the backend's text: MAJOR (this check cannot see the CLI)", () => {
    const d = scratch();
    writeFileSync(join(d, "old.bin"), "nothing here");
    writeFileSync(join(d, "new.bin"), "nothing here");
    const r = run(join(d, "old.bin"), join(d, "new.bin"), manifestFile(d));
    expect([r.verdict, /cannot see the CLI's text/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("reads UTF-16 and JSON-escaped text too (bundled JS)", () => {
    const d = scratch();
    writeFileSync(join(d, "old.bin"), OLD);
    const utf16 = Buffer.from("Do you trust the files in this folder", "utf16le");
    writeFileSync(join(d, "new.bin"), Buffer.concat([Buffer.from(OLD.replace("Do you trust the files in this folder", "")), utf16]));
    expect(run(join(d, "old.bin"), join(d, "new.bin"), manifestFile(d)).verdict).toBe("PRECHECK: NONE");
  });
  it("reads a .tgz, a .zip, a gzip file and a directory, in memory, and writes nothing", () => {
    const d = scratch();
    const m = manifestFile(d);
    mkdirSync(join(d, "pkg/vendor/bin"), { recursive: true });
    writeFileSync(join(d, "pkg/vendor/bin/cli"), OLD);
    execFileSync("tar", ["-czf", join(d, "cli.tgz"), "-C", d, "pkg"]);
    writeFileSync(join(d, "cli.gz"), gzipSync(Buffer.from(OLD)));
    execFileSync("python3", ["-I", "-c", `import zipfile; z=zipfile.ZipFile(${JSON.stringify(join(d, "cli.zip"))},"w"); z.writestr("cli", open(${JSON.stringify(join(d, "pkg/vendor/bin/cli"))}).read()); z.close()`]);
    const before = execFileSync("find", [d], { encoding: "utf8" });
    for (const [old, neu] of [["pkg", "cli.tgz"], ["cli.gz", "cli.zip"], ["cli.tgz", "pkg"]]) {
      expect(run(join(d, old!), join(d, neu!), m).verdict, `${old} → ${neu}`).toBe("PRECHECK: NONE");
    }
    expect(execFileSync("find", [d], { encoding: "utf8" })).toBe(before);
  });
  it("a path that does not exist ends with a MAJOR verdict line (the run failed), never a silent pass", () => {
    const d = scratch();
    let out = "";
    try { execFileSync("python3", ["-I", PRECHECK, "fake", join(d, "none"), join(d, "none"), "--manifest", manifestFile(d)], { encoding: "utf8" }); }
    catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
    expect(out.trim().split("\n").at(-1)).toBe("PRECHECK: MAJOR");
  });
});

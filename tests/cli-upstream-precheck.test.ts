/**
 * The daily upstream-CLI precheck (scripts/manual/cli-upstream-precheck/):
 * - manifest.json is what the detectors' source says now — a detector literal added, changed or removed in src/ without
 *   rebuilding it fails here;
 * - precheck.py cannot run anything or reach the network (no such import), and its verdict follows its rules on small
 *   synthetic artifacts in every format it reads (a file, a .tgz, a .zip, a gzip file, a directory).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, SURFACES, buildManifest, declarationNames, literalsOf, manifestKeys, regexRuns, surfaceOf, type Manifest } from "../scripts/manual/cli-upstream-precheck/build-manifest.js";

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
    // #1575 review: required whitespace is a space; machine codes are kept on their own.
    [String.raw`no\s+device\s+registration found for token`, ["no device registration found for token"]],
    [String.raw`unexpected\s+status\s+401\b`, ["unexpected status 401"]],
    [String.raw`error.*authentication|UNAUTHENTICATED`, ["UNAUTHENTICATED"]],
    [String.raw`(?:invalid_api_key|authentication_error)`, ["invalid_api_key", "authentication_error"]],
    [String.raw`optional\s*space here`, ["space here"]],
  ])("%s → %j", (src, runs) => { expect(regexRuns(src)).toEqual(runs); });
  it("names a surface from the declaration when sources.json does not", () => {
    expect([surfaceOf(["TRUST_TITLE"]), surfaceOf(["getErrorPatterns"]), surfaceOf(["x"], { x: "exit" }), surfaceOf(["helper"])])
      .toEqual(["trust", "error", "exit", "other"]);
  });
});

describe("the manifest holds the detectors AgEnD really runs (#1575 review P1-1)", () => {
  it.each([
    ["kiro-cli", "no device registration found for token"],   // new RegExp("…|…" + "…")
    ["codex", "invalid_api_key"],                               // new RegExp(String.raw`…${…}…`)
    ["codex", "invalid api key"],
    ["claude", "Login failed: Request failed with status code 400"],   // LOGIN_FLOWS["claude-code"]
    ["agy", "UNAUTHENTICATED"],                                 // a machine code in a regex
  ])("%s: %j", (b, text) => {
    expect(committed().backends[b]!.literals.some((l) => l.text === text)).toBe(true);
  });
  it("reads every string inside RegExp(…) as regex source: plain, concatenated, templated and String.raw", () => {
    const src = [
      'const A = new RegExp("Esc to cancel\\\\.");',
      'const B = new RegExp("Press any key " + "to continue\\\\.");',
      'const C = new RegExp(`Login failed\\\\. ${X} try again later`);',
      'const D = new RegExp(String.raw`Sign in\\s+required\\.`);',
      'const E = "Plain screen text here";',
    ].join("\n");
    const texts = literalsOf({ file: "src/inline.ts" }, src).map((l) => `${l.kind}:${l.text}`).sort();
    expect(texts).toEqual(["regex:Esc to cancel", "regex:Login failed", "regex:Press any key", "regex:Sign in required", "regex:to continue", "regex:try again later", "string:Plain screen text here"]);
  });
  it("leaves out the names AgEnD gives its own dialogs (a helper's name/key/description argument)", () => {
    const all = Object.values(committed().backends).flatMap((v) => v.literals.map((l) => l.text));
    for (const own of ["Claude Bypass Permissions warning", "Claude workspace trust dialog", "Kiro V3 ease-in prompt"]) expect(all, own).not.toContain(own);
  });
  it("every declaration sources.json names exists in its file (a typo would silently select nothing)", () => {
    const sources = JSON.parse(readFileSync(join(DIR, "sources.json"), "utf8")) as { backends: Record<string, Array<{ file: string; symbols?: string[]; exclude?: string[]; surfaces?: Record<string, string> }>> };
    const missing: string[] = [];
    for (const [b, entries] of Object.entries(sources.backends)) for (const e of entries) {
      const names = declarationNames(e.file);
      for (const n of [...(e.symbols ?? []), ...Object.keys(e.surfaces ?? {})]) if (!names.has(n)) missing.push(`${b} ${e.file} ${n}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("precheck.py compares prompt-like strings as a release would show them", () => {
  it.each([
    ["minified names inside ${…} are not compared", "retrying in ${(Pe/1000).toFixed(1)}s", "retrying in ${}s"],
    ["the string ends at a control byte", "Do you want to proceed?\u0001next", "Do you want to proceed?"],
    ["nothing else is cut (a product name stays whole)", "Do you want to connect to GitHub?", "Do you want to connect to GitHub?"],
  ])("%s", (_label, raw, key) => {
    const out = execFileSync("python3", ["-I", "-c", `import sys; sys.argv=["x"]; sys.path.insert(0, ${JSON.stringify(DIR)}); import precheck; print(precheck.normalize(sys.stdin.buffer.read()))`], { input: raw, encoding: "utf8" });
    expect(out.trimEnd()).toBe(key);
  });
});

describe("precheck.py is static by construction", () => {
  it("imports nothing that runs a program or opens a connection", () => {
    const src = readFileSync(PRECHECK, "utf8");
    expect(src.match(/^\s*(?:import|from)\s+(\S+)/gm)!.map((l) => l.trim().split(/\s+/)[1]).sort())
      .toEqual(["bisect", "io", "json", "os", "re", "sys", "tarfile", "zipfile", "zlib"]);
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
function run(old: string, neu: string, m: string, extra: string[] = []): { verdict: string; out: string; status: number | null } {
  const r = spawnSync("python3", ["-I", PRECHECK, "fake", old, neu, "--manifest", m, ...extra], { encoding: "utf8" });
  return { verdict: r.stdout.trim().split("\n").at(-1)!, out: r.stdout, status: r.status };
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
    expect(r.out.trim().split("\n").at(-2)).toMatch(/^BASIS: hard=[1-9]\d*; hinted=0$/);
    expect(r.out).toContain("BASIS-DETAIL: missing 1,");
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
    expect(out.trim().split("\n").at(-2)).toBe("BASIS: hard=1; hinted=0");
  });
  it("every run's last two lines are BASIS: hard=<int>; hinted=<int> and the verdict (the schedule parses them)", () => {
    for (const neu of [OLD, OLD.replace("Rate limited, retrying soon", "x"), `${OLD}${T}${pad(4)}Do you want to **share** all credentials?`]) {
      const lines = pair(neu).out.trim().split("\n");
      expect(lines.at(-2), neu.slice(-40)).toMatch(/^BASIS: hard=\d+; hinted=\d+$/);
      expect(lines.at(-1)).toMatch(/^PRECHECK: (MAJOR|MINOR|NONE)$/);
    }
  });
});

// ── #1575 review: what must never pass as NONE or MINOR ──

const T = "Do you trust the files in this folder", B = "esc to interrupt now", R = "Rate limited, retrying soon";
const NEW_Q = "Do you want to share all credentials?";
function files(old: string | Buffer, neu: string | Buffer): { old: string; neu: string; m: string; d: string } {
  const d = scratch();
  writeFileSync(join(d, "old.bin"), old);
  writeFileSync(join(d, "new.bin"), neu);
  return { old: join(d, "old.bin"), neu: join(d, "new.bin"), m: manifestFile(d), d };
}

describe("removing one detector literal from a real backend's text is MAJOR, with the real manifest (P1-1)", () => {
  it.each([
    ["kiro-cli", "no device registration found for token"],
    ["codex", "invalid_api_key"],
    ["claude", "Login failed: Request failed with status code 400"],
    ["agy", "UNAUTHENTICATED"],
  ])("%s without %j", (b, target) => {
    const markers = committed().backends[b]!.literals.map((l) => l.text).filter((t) => t !== target && !target.includes(t) && !t.includes(target)).slice(0, 3);
    const d = scratch();
    writeFileSync(join(d, "old.bin"), [...markers, target].join("\0"));
    writeFileSync(join(d, "new.bin"), markers.join("\0"));
    writeFileSync(join(d, "same.bin"), [...markers, target].join("\0"));
    const removed = spawnSync("python3", ["-I", PRECHECK, b, join(d, "old.bin"), join(d, "new.bin")], { encoding: "utf8" }).stdout;
    const control = spawnSync("python3", ["-I", PRECHECK, b, join(d, "old.bin"), join(d, "same.bin")], { encoding: "utf8" }).stdout;
    expect(removed.trim().split("\n").at(-1)).toBe("PRECHECK: MAJOR");
    expect(removed).toContain(`missing: [`);
    expect(control.trim().split("\n").at(-1)).toBe("PRECHECK: NONE");
  });
});

describe("new prompts are found wherever they sit, in every text form (P1-2)", () => {
  it("next to the 65th occurrence of a literal (every occurrence places prompts)", () => {
    const old = `${`${T}${pad(4)}`.repeat(64)}${B}${pad(4)}${R}${pad(3000)}${T}${pad(8)}`;
    const f = files(old, `${old}${NEW_Q}`);
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
  it("in UTF-16LE text, as its literals are", () => {
    const u = (s: string) => Buffer.from(s, "utf16le");
    const old = Buffer.concat([u(T), Buffer.alloc(8), u(B), Buffer.alloc(8), u(R), Buffer.alloc(8)]);
    const f = files(old, Buffer.concat([old, u(NEW_Q)]));
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, r.out.includes("literals in the old artifact: 3 of 4")]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a product name is not cut: OpenAI → GitHub beside a known literal is MAJOR", () => {
    const f = files(`${OLD}${T}${pad(4)}Do you want to connect to OpenAI?`, `${OLD}${T}${pad(4)}Do you want to connect to GitHub?`);
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
  it("markdown ** proves nothing: a new question with ** beside a known literal is MAJOR, with a hint (R2 P1)", () => {
    const f = files(`${OLD}${T}${pad(4)}`, `${OLD}${T}${pad(4)}Do you want to **share** all credentials?`);
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, /hint: has markdown \*\*/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
    expect(r.out.trim().split("\n").at(-2)).toBe("BASIS: hard=0; hinted=1");
  });
  it("control: the same emphasized question unchanged is NONE", () => {
    const same = `${OLD}${T}${pad(4)}Do you want to **share** all credentials?`;
    const f = files(same, same);
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: NONE");
  });
  it("control: a Bun string table's length byte after a string is not part of it (NONE)", () => {
    const head = Buffer.from(`${OLD}${T}${pad(4)}Yes, and always allow access to `);
    const f = files(Buffer.concat([head, Buffer.from([0x03, 0, 0, 0x80])]), Buffer.concat([head, Buffer.from([0x39, 0, 0, 0x80])]));   // "9" = the next entry's length
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: NONE");
  });
  it("a changed question after a kept prefix is MAJOR even when its words are elsewhere in the old release (R2 P1)", () => {
    const base = `${OLD}${pad(3000)}remove all files?${pad(3000)}`;
    const f = files(`${base}${T}${pad(4)}Do you want to proceed: keep current settings?`, `${base}${T}${pad(4)}Do you want to proceed: remove all files?`);
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, /hint: the old release has/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("…and when the old release has only the first words of the new ending (R2 P1)", () => {
    const base = `${OLD}${pad(3000)}remove the current worki with no deletion${pad(3000)}`;
    const f = files(`${base}${T}${pad(4)}Do you want to proceed: keep current settings?`, `${base}${T}${pad(4)}Do you want to proceed: remove the current working directory and its contents?`);
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
  it("an old prompt beside a changed neighbour is MAJOR too (a native string boundary cannot be proven), with a hint", () => {
    const old = `${OLD}${R}${pad(4)}Yes, proceed${T}${pad(30)}Yes, proceedn  No, quit${pad(4)}`;
    const f = files(old, old.replace(`Yes, proceed${T}`, `Yes, proceedn${T}`));
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, /only a neighbouring string changed\?/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("…but a neighbour the old release never had is a new prompt (MAJOR)", () => {
    const old = `${OLD}${R}${pad(4)}Yes, proceed${T}${pad(30)}Yes, proceedn  No, quit${pad(4)}`;
    const f = files(old, old.replace(`Yes, proceed${T}`, "Yes, proceednDo you share all the credentials"));
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
});

describe("a scan that could not read everything is MAJOR, whatever else it saw (P1-3, P2-2)", () => {
  const MARKERS = [T, B, R].join("\0");
  it("an unreadable directory inside the artifact", () => {
    if (process.getuid?.() === 0) return;           // root reads everything: nothing to show
    const d = scratch();
    for (const side of ["old", "new"]) { mkdirSync(join(d, side, "locked"), { recursive: true }); writeFileSync(join(d, side, "cli"), MARKERS); }
    chmodSync(join(d, "new", "locked"), 0o000);
    try {
      const r = run(join(d, "old"), join(d, "new"), manifestFile(d));
      expect([r.verdict, /INCOMPLETE \(new\): cannot list/.test(r.out), r.status]).toEqual(["PRECHECK: MAJOR", true, 4]);
    } finally { chmodSync(join(d, "new", "locked"), 0o755); }
  });
  it("a file over the size bound", () => {
    const d = scratch();
    for (const side of ["old", "new"]) { mkdirSync(join(d, side)); writeFileSync(join(d, side, "cli"), MARKERS); }
    writeFileSync(join(d, "new", "big"), "x".repeat(2048));
    const r = run(join(d, "old"), join(d, "new"), manifestFile(d), ["--max-member", "1024"]);
    expect([r.verdict, /big: larger than 1024 bytes/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a broken gzip file (its raw bytes are not scanned instead)", () => {
    const f = files(MARKERS, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(MARKERS)]));
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, /broken gzip|truncated gzip/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a gzip file that expands past the bound is refused while it is being expanded", () => {
    const big = gzipSync(Buffer.from(`${MARKERS}\0${"y".repeat(4100)}`));
    const f = files(MARKERS, big);
    const r = run(f.old, f.neu, f.m, ["--max-member", "1024"]);
    expect([r.verdict, /decompresses to more than 1024 bytes/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
});

describe("every failure still ends with the verdict line, and a non-zero exit (P2-1)", () => {
  it("a manifest that is not JSON", () => {
    const f = files(OLD, OLD);
    writeFileSync(f.m, "{");
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, r.status !== 0]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("an error no check anticipated (a manifest literal that cannot be encoded) still ends with the verdict", () => {
    const f = files(OLD, OLD);
    writeFileSync(f.m, '{"backends":{"fake":{"literals":[{"text":"\\ud800 lone surrogate","surface":"error"}]}}}');
    const r = run(f.old, f.neu, f.m);
    expect([r.verdict, r.status !== 0, /could not run: UnicodeEncodeError/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true, true]);
  });
  it("a zip member whose bytes were changed (CRC error)", () => {
    const d = scratch();
    execFileSync("python3", ["-I", "-c", `import zipfile; z=zipfile.ZipFile(${JSON.stringify(join(d, "cli.zip"))},"w"); z.writestr("cli", ${JSON.stringify(OLD)}); z.close()`]);
    const zip = readFileSync(join(d, "cli.zip"));
    const at = zip.indexOf(Buffer.from("Do you trust"));
    zip[at] = zip[at]! ^ 1;
    writeFileSync(join(d, "bad.zip"), zip);
    writeFileSync(join(d, "old.bin"), OLD);
    const r = run(join(d, "old.bin"), join(d, "bad.zip"), manifestFile(d));
    expect([r.verdict, r.status !== 0]).toEqual(["PRECHECK: MAJOR", true]);
  });
});

describe("compressed and archived input is read whole or the scan is incomplete (R2 P1)", () => {
  const MARK = Buffer.from([T, B, R].join("\0"));
  const gz = (b: Buffer) => gzipSync(b);
  const verdict = (old: Buffer, neu: Buffer, extra: string[] = []) => { const f = files(old, neu); return run(f.old, f.neu, f.m, extra); };
  it("control: one gzip member, and a gzip of a tar, read whole: NONE", () => {
    expect(verdict(MARK, gz(MARK)).verdict).toBe("PRECHECK: NONE");
    const d = scratch(); mkdirSync(join(d, "p")); writeFileSync(join(d, "p", "cli"), MARK);
    execFileSync("tar", ["-czf", join(d, "c.tgz"), "-C", d, "p"]);
    expect(verdict(MARK, readFileSync(join(d, "c.tgz"))).verdict).toBe("PRECHECK: NONE");
  });
  it("every gzip member is read: a new question in member 2 is found", () => {
    const r = verdict(MARK, Buffer.concat([gz(MARK), gz(Buffer.from(`${T}${pad(4)}${NEW_Q}`))]));
    expect(r.verdict).toBe("PRECHECK: MAJOR");
    expect(r.out).toContain("share all credentials");
  });
  it("a truncated second gzip member is incomplete", () => {
    const r = verdict(MARK, Buffer.concat([gz(Buffer.concat([MARK, Buffer.alloc(1024)])), Buffer.from([0x1f, 0x8b, 0x08, 0x00])]));
    expect([r.verdict, /truncated gzip|broken gzip/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("the bound counts all members together", () => {
    const r = verdict(MARK, Buffer.concat([gz(MARK), gz(Buffer.from("z".repeat(4166)))]), ["--max-member", "1024"]);
    expect([r.verdict, /decompresses to more than 1024 bytes/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a zip cut before its central directory is a broken zip, never read as raw bytes", () => {
    const d = scratch();
    execFileSync("python3", ["-I", "-c", `import zipfile; z=zipfile.ZipFile(${JSON.stringify(join(d, "c.zip"))},"w",zipfile.ZIP_STORED); z.writestr("cli", open(0,"rb").read()); z.close()`], { input: MARK });
    const zip = readFileSync(join(d, "c.zip"));
    const r = verdict(MARK, zip.subarray(0, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))));
    expect([r.verdict, /broken zip/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a tar whose header was changed (checksum wrong) is a broken tar, never read as raw bytes", () => {
    const d = scratch(); mkdirSync(join(d, "p")); writeFileSync(join(d, "p", "cli"), MARK);
    execFileSync("tar", ["-cf", join(d, "c.tar"), "-C", d, "p/cli"]);
    const tar = readFileSync(join(d, "c.tar"));
    tar[0] = tar[0]! ^ 1;
    const r = verdict(MARK, tar);
    expect([r.verdict, /INCOMPLETE \(new\): c?.*(broken tar|bad checksum)/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a corrupt header after the first member, which tar readers stop at silently, is incomplete", () => {
    const d = scratch(); mkdirSync(join(d, "p"));
    writeFileSync(join(d, "p", "a"), MARK);
    writeFileSync(join(d, "p", "b"), `${T}${pad(4)}${NEW_Q}`);
    execFileSync("tar", ["-cf", join(d, "c.tar"), "-C", d, "p/a", "p/b"]);
    const tar = readFileSync(join(d, "c.tar"));
    const second = tar.indexOf(Buffer.from("p/b\0"));
    tar[second] = tar[second]! ^ 1;                       // its checksum no longer matches
    const r = verdict(MARK, tar);
    expect([r.verdict, /data after the last readable tar header/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("the bound counts the members together: two that fit alone but not together", () => {
    const r = verdict(MARK, Buffer.concat([gz(Buffer.concat([MARK, Buffer.from("a".repeat(600))])), gz(Buffer.from("b".repeat(700)))]), ["--max-member", "1024"]);
    expect([r.verdict, /decompresses to more than 1024 bytes/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
  it("a tar.gz whose outer gzip CRC is wrong is incomplete (the gzip is checked to its end)", () => {
    const d = scratch(); mkdirSync(join(d, "p")); writeFileSync(join(d, "p", "cli"), MARK);
    execFileSync("tar", ["-czf", join(d, "c.tgz"), "-C", d, "p"]);
    const bad = readFileSync(join(d, "c.tgz"));
    bad[bad.length - 8] = bad[bad.length - 8]! ^ 1;
    const r = verdict(MARK, bad);
    expect([r.verdict, /broken gzip/.test(r.out)]).toEqual(["PRECHECK: MAJOR", true]);
  });
});

describe("UTF-16 questions are read whole, at their real place (R2 P2)", () => {
  const u = (s: string) => Buffer.from(s, "utf16le");
  const BASE = Buffer.concat([Buffer.from("binary-prefix\x01\x02"), u(T), Buffer.alloc(8), u(B), Buffer.alloc(8), u(R), Buffer.alloc(8)]);
  it("a question with CJK in it is found", () => {
    const f = files(BASE, Buffer.concat([BASE, u(T), Buffer.alloc(4), u("Do you want to share 私密 credentials?")]));
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
  it("its physical end places it: a literal 590 bytes after a long UTF-16 question is near it", () => {
    const q = u("Do you want to share all credentials with every outside collaborator and publish every stored password?");
    const f = files(BASE, Buffer.concat([BASE, Buffer.alloc(800), q, Buffer.alloc(590), u(T)]));
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MAJOR");
  });
  it("control: 1000 bytes away it is elsewhere (MINOR)", () => {
    const q = u("Do you want to share all credentials with every outside collaborator and publish every stored password?");
    const f = files(BASE, Buffer.concat([BASE, Buffer.alloc(1200), q, Buffer.alloc(1000), u(T)]));
    expect(run(f.old, f.neu, f.m).verdict).toBe("PRECHECK: MINOR");
  });
});

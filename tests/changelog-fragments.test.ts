/**
 * CHANGELOG fragments (fleet decision e723a50a): a PR adds changes/<issue>.md + changes/<issue>.zh-TW.md;
 * scripts/changelog-assemble.mjs moves them into docs/CHANGELOG*.md; ci.yml fails a PR that edits the CHANGELOG
 * directly (scripts/changelog-guard.mjs), except the assemble commit, marked by its "Changelog: assemble" trailer.
 *
 * The scripts run as CI and a release runs them: `node scripts/…` in a scratch directory (a scratch git repository
 * for the guard), and the guard's ci.yml steps are read out of the YAML and run with bash.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ASSEMBLE = join(ROOT, "scripts", "changelog-assemble.mjs");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

const EN = `# Changelog

## [Unreleased]

### Added
- **Existing added (#1).** a

### Fixed
- **Existing fix (#2).** b

## [1.0.0] - 2026-01-01

### Fixed
- **Old fix (#0).** c
`;
const ZH = `# 變更紀錄

## [未發佈] (Unreleased)

### 新增 (Added)
- **既有新增（#1）。** a

### 修正 (Fixed)
- **既有修正（#2）。** b

## [1.0.0] - 2026-01-01

### 修正 (Fixed)
- **舊修正（#0）。** c
`;
const frag = (section: string, body: string) => `---\nsection: ${section}\n---\n${body}\n`;

function repo(files: Record<string, string>) {
  const root = scratch("agend-changelog-");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "changes"), { recursive: true });
  writeFileSync(join(root, "docs", "CHANGELOG.md"), EN);
  writeFileSync(join(root, "docs", "CHANGELOG.zh-TW.md"), ZH);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "changes", name), text);
  const run = (...args: string[]) => spawnSync(process.execPath, [ASSEMBLE, "--root", root, ...args], { encoding: "utf8" });
  const read = () => ({
    en: readFileSync(join(root, "docs", "CHANGELOG.md"), "utf8"),
    zh: readFileSync(join(root, "docs", "CHANGELOG.zh-TW.md"), "utf8"),
    changes: readdirSync(join(root, "changes")).sort(),
  });
  return { root, run, read };
}

const PAIR = (n: string, section: string, en = `- **EN ${n}.** x`, zh = `- **ZH ${n}。** x`) => ({
  [`${n}.md`]: frag(section, en), [`${n}.zh-TW.md`]: frag(section, zh),
});

describe("changelog-assemble: into [Unreleased]", () => {
  it("both languages; top of the subsection, by issue number then name; fragments deleted", () => {
    // 100 after 42: by number, not as text.
    const r = repo({ ...PAIR("100", "Fixed"), ...PAIR("42", "Fixed"), ...PAIR("42-second", "Fixed"), "README.md": "# notes\n" });
    const res = r.run();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Changelog: assemble");
    const { en, zh, changes } = r.read();
    expect(en).toContain("### Fixed\n- **EN 42.** x\n- **EN 42-second.** x\n- **EN 100.** x\n- **Existing fix (#2).** b\n");
    expect(zh).toContain("### 修正 (Fixed)\n- **ZH 42。** x\n- **ZH 42-second。** x\n- **ZH 100。** x\n- **既有修正（#2）。** b\n");
    expect(en).toContain("## [1.0.0] - 2026-01-01\n\n### Fixed\n- **Old fix (#0).** c\n");   // the release is untouched
    expect(changes).toEqual(["README.md"]);
  });

  it("a missing subsection is created in canonical order: before a later one, or at the end of the release", () => {
    const r = repo({
      ...PAIR("5", "Upgrade Notes"), ...PAIR("6", "Changed"), ...PAIR("7", "Security", "- **EN 7.** s\n  second line"),
    });
    expect(r.run().status).toBe(0);
    const { en, zh } = r.read();
    expect(en).toContain(`## [Unreleased]

### Upgrade Notes
- **EN 5.** x

### Added
- **Existing added (#1).** a

### Changed
- **EN 6.** x

### Fixed
- **Existing fix (#2).** b

### Security
- **EN 7.** s
  second line

## [1.0.0] - 2026-01-01
`);
    expect(zh).toContain("### 升級注意事項 (Upgrade Notes)\n- **ZH 5。** x\n\n### 新增 (Added)");
    expect(zh).toContain("### 變更 (Changed)\n- **ZH 6。** x\n\n### 修正 (Fixed)");
    expect(zh).toContain("### 安全 (Security)\n- **ZH 7。** x\n\n## [1.0.0] - 2026-01-01");
  });

  it("no blank line before the next release: the new subsection still gets one", () => {
    const r = repo(PAIR("9", "Security"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n### Fixed\n- a\n## [1.0.0]\n- b\n");
    expect(r.run().status).toBe(0);
    expect(r.read().en).toBe("# Changelog\n\n## [Unreleased]\n### Fixed\n- a\n\n### Security\n- **EN 9.** x\n\n## [1.0.0]\n- b\n");
  });

  it("an empty [Unreleased] at the end of the file", () => {
    const r = repo(PAIR("8", "Fixed"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    writeFileSync(join(r.root, "docs", "CHANGELOG.zh-TW.md"), "# 變更紀錄\n\n## [未發佈] (Unreleased)\n");
    expect(r.run().status).toBe(0);
    expect(r.read().en).toBe("# Changelog\n\n## [Unreleased]\n\n### Fixed\n- **EN 8.** x\n");
  });
});

describe("changelog-assemble: --release", () => {
  it("creates ## [X.Y.Z] - date under [Unreleased] in both files and leaves [Unreleased] as it was", () => {
    const r = repo({ ...PAIR("10", "Added"), ...PAIR("11", "Fixed") });
    expect(r.run("--release", "1.1.0", "--date", "2026-10-08").status).toBe(0);
    const { en, zh } = r.read();
    expect(en).toContain(`### Fixed
- **Existing fix (#2).** b

## [1.1.0] - 2026-10-08

### Added
- **EN 10.** x

### Fixed
- **EN 11.** x

## [1.0.0] - 2026-01-01
`);
    expect(zh).toContain("## [1.1.0] - 2026-10-08\n\n### 新增 (Added)\n- **ZH 10。** x\n\n### 修正 (Fixed)\n- **ZH 11。** x\n\n## [1.0.0]");
  });

  it("an existing release section is filled, not duplicated", () => {
    const r = repo(PAIR("12", "Fixed"));
    expect(r.run("--release", "1.0.0").status).toBe(0);
    const { en } = r.read();
    expect(en.match(/## \[1\.0\.0\]/g)).toHaveLength(1);
    expect(en).toContain("## [1.0.0] - 2026-01-01\n\n### Fixed\n- **EN 12.** x\n- **Old fix (#0).** c\n");
  });

  it("bad arguments → exit 2, nothing written", () => {
    const r = repo(PAIR("13", "Fixed"));
    for (const args of [["--release", "v1.2"], ["--release", "1.2.0", "--date", "8 Oct"], ["--date", "2026-10-08"], ["--bogus"]]) {
      expect(r.run(...args).status, args.join(" ")).toBe(2);
    }
    expect(r.read().en).toBe(EN);
  });
});

describe("changelog-assemble: idempotence", () => {
  it("a second run finds no fragments and changes nothing", () => {
    const r = repo({ ...PAIR("20", "Fixed"), ...PAIR("21", "Added") });
    expect(r.run().status).toBe(0);
    const once = r.read();
    const again = r.run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("no fragments");
    expect(r.read()).toEqual(once);
  });

  it("fragments put back after a run (an interrupted one) are not added twice", () => {
    const files = { ...PAIR("22", "Fixed"), ...PAIR("23", "Security") };
    const r = repo(files);
    expect(r.run().status).toBe(0);
    const once = r.read();
    for (const [name, text] of Object.entries(files)) writeFileSync(join(r.root, "changes", name), text);
    expect(r.run().status).toBe(0);
    expect(r.read()).toEqual(once);
  });
});

describe("changelog-assemble: an entry is already there only as a whole (Prism #1333 r1)", () => {
  it("an existing entry that merely starts with the new one does not swallow it", () => {
    const r = repo(PAIR("60", "Fixed", "- Added automatic restart support", "- 新增自動重啟支援"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- Added automatic restart support detection.\n"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.zh-TW.md"), ZH.replace("### 修正 (Fixed)\n", "### 修正 (Fixed)\n- 新增自動重啟支援偵測。\n"));
    expect(r.run().status).toBe(0);
    const { en, zh, changes } = r.read();
    expect(en).toContain("### Fixed\n- Added automatic restart support\n- Added automatic restart support detection.\n");
    expect(zh).toContain("### 修正 (Fixed)\n- 新增自動重啟支援\n- 新增自動重啟支援偵測。\n");
    expect(changes).toEqual([]);
  });

  it("an entry with continuation lines is not the same as its first line, and vice versa", () => {
    // The fragment adds a continuation to an existing one-line entry: a different entry.
    const r = repo(PAIR("61", "Fixed", "- **Existing fix (#2).** b\n  more detail"));
    expect(r.run().status).toBe(0);
    expect(r.read().en).toContain("### Fixed\n- **Existing fix (#2).** b\n  more detail\n- **Existing fix (#2).** b\n");
    // The fragment is the first line of an existing multi-line entry: also a different entry.
    const r2 = repo(PAIR("63", "Fixed", "- **Long (#63).** a"));
    writeFileSync(join(r2.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- **Long (#63).** a\n  continued\n"));
    expect(r2.run().status).toBe(0);
    expect(r2.read().en).toContain("### Fixed\n- **Long (#63).** a\n- **Long (#63).** a\n  continued\n");
  });

  it("the whole multi-line entry already present → skipped (the rerun case)", () => {
    const body = "- **Twice (#62).** a\n  b";
    const r = repo(PAIR("62", "Fixed", body));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", `### Fixed\n${body}\n`));
    expect(r.run().status).toBe(0);
    expect(r.read().en.split(body)).toHaveLength(2);
  });
});

describe("changelog-assemble: every line the parser accepts takes part in the comparison (Prism #1333 r2)", () => {
  it("an unindented continuation (Markdown lazy continuation) is part of the entry: the new explanation is not dropped", () => {
    const r = repo(PAIR("64", "Fixed", "- Added safe mode.\nThe existing installations must opt in manually.", "- 新增安全模式。\n既有安裝需要手動啟用。"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- Added safe mode.\n"));
    writeFileSync(join(r.root, "docs", "CHANGELOG.zh-TW.md"), ZH.replace("### 修正 (Fixed)\n", "### 修正 (Fixed)\n- 新增安全模式。\n"));
    expect(r.run("--check").status).toBe(0);
    expect(r.run().status).toBe(0);
    const { en, zh, changes } = r.read();
    expect(en).toContain("### Fixed\n- Added safe mode.\nThe existing installations must opt in manually.\n- Added safe mode.\n");
    expect(zh).toContain("### 修正 (Fixed)\n- 新增安全模式。\n既有安裝需要手動啟用。\n- 新增安全模式。\n");
    expect(changes).toEqual([]);
  });

  it("the CHANGELOG's own lazy-continued entry is compared whole: its first line alone is a different entry", () => {
    const r = repo(PAIR("65", "Fixed", "- Added safe mode."));
    writeFileSync(join(r.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- Added safe mode.\nOpt in manually.\n"));
    expect(r.run().status).toBe(0);
    expect(r.read().en).toContain("### Fixed\n- Added safe mode.\n- Added safe mode.\nOpt in manually.\n");
    // …and the same lazy entry, already there in full → skipped.
    const r2 = repo(PAIR("66", "Fixed", "- Added safe mode.\nOpt in manually."));
    writeFileSync(join(r2.root, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- Added safe mode.\nOpt in manually.\n"));
    expect(r2.run().status).toBe(0);
    expect(r2.read().en.split("- Added safe mode.\nOpt in manually.")).toHaveLength(2);
  });

  it.each([
    ["text after a blank line, not indented", "- Added safe mode.\n\nThe existing installations must opt in manually."],
    ["a second paragraph, not indented, after an indented one", "- A.\n  more\n\nloose text"],
  ])("a line outside the list item (%s) → refused by --check and by assemble, nothing written", (_label, body) => {
    const r = repo(PAIR("67", "Fixed", body));
    const before = r.read();
    for (const args of [["--check"], []]) {
      const res = r.run(...args);
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stderr).toContain("outside its list item");
    }
    expect(r.read()).toEqual(before);
  });

  it("indented continuations and blank lines between indented paragraphs stay valid", () => {
    const r = repo(PAIR("68", "Fixed", "- **A (#68).** a\n  b\n\n  c\n  - nested"));
    expect(r.run("--check").status).toBe(0);
    expect(r.run().status).toBe(0);
    expect(r.read().en).toContain("### Fixed\n- **A (#68).** a\n  b\n\n  c\n  - nested\n");
  });
});

describe("changelog-assemble: an interrupted cleanup is finished by running it again (Prism #1333 r1)", () => {
  // Simulate the failure: assemble succeeded in writing both CHANGELOGs, then deleting one half failed.
  it.each([["the zh-TW half", "3.zh-TW.md"], ["the en half", "3.md"]])("%s left behind → a rerun removes it and adds nothing", (_label, left) => {
    const files = PAIR("3", "Fixed");
    const r = repo(files);
    expect(r.run().status).toBe(0);
    const once = r.read();
    writeFileSync(join(r.root, "changes", left), files[left]!);
    const check = r.run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("removed by running the assembler again");
    const again = r.run();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(`removed changes/${left}, left by an interrupted run`);
    expect(r.read()).toEqual(once);
  });

  it("the same with --release: the leftover is judged against that release", () => {
    const files = PAIR("4", "Added");
    const r = repo(files);
    expect(r.run("--release", "1.1.0", "--date", "2026-10-08").status).toBe(0);
    const once = r.read();
    writeFileSync(join(r.root, "changes", "4.zh-TW.md"), files["4.zh-TW.md"]!);
    expect(r.run().status).toBe(1);                                   // not in [Unreleased]: a real orphan there
    expect(r.run("--release", "1.1.0", "--date", "2026-10-08").status).toBe(0);
    expect(r.read()).toEqual(once);
  });

  it("a half whose entry is not in the CHANGELOG is still an error, and nothing is written", () => {
    const r = repo({ ...PAIR("70", "Fixed"), "71.md": frag("Fixed", "- **lonely.** x") });
    const before = r.read();
    const res = r.run();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("changes/71.md: no changes/71.zh-TW.md");
    expect(r.read()).toEqual(before);
  });
});

describe("changelog-assemble: a bad fragment writes nothing", () => {
  const good = PAIR("30", "Fixed");
  it.each([
    ["no front-matter", { "31.md": "- **x.** y\n", "31.zh-TW.md": frag("Fixed", "- y") }, /no front-matter/],
    ["unknown section", PAIR("31", "Fixes"), /section `Fixes` is not one of/],
    ["lower-case section", PAIR("31", "fixed"), /section `fixed`/],
    ["unknown key", { "31.md": "---\nsection: Fixed\nissue: 31\n---\n- x\n", "31.zh-TW.md": frag("Fixed", "- y") }, /unknown front-matter key `issue`/],
    ["section twice", { "31.md": "---\nsection: Fixed\nsection: Added\n---\n- x\n", "31.zh-TW.md": frag("Fixed", "- y") }, /given twice/],
    ["no section", { "31.md": "---\n\n---\n- x\n", "31.zh-TW.md": frag("Fixed", "- y") }, /no `section`/],
    ["empty entry", { "31.md": frag("Fixed", ""), "31.zh-TW.md": frag("Fixed", "- y") }, /entry is empty/],
    ["not a list item", { "31.md": frag("Fixed", "Fixed the thing."), "31.zh-TW.md": frag("Fixed", "- y") }, /list item/],
    ["a heading in the entry", { "31.md": frag("Fixed", "- x\n### Fixed\n- z"), "31.zh-TW.md": frag("Fixed", "- y") }, /heading/],
    ["no zh-TW pair", { "31.md": frag("Fixed", "- x") }, /no changes\/31\.zh-TW\.md/],
    ["no en pair", { "31.zh-TW.md": frag("Fixed", "- y") }, /no changes\/31\.md/],
    ["sections differ", { "31.md": frag("Fixed", "- x"), "31.zh-TW.md": frag("Added", "- y") }, /en says `Fixed`, zh-TW says `Added`/],
    ["a bad name", { "fix-31.md": frag("Fixed", "- x") }, /changes\/fix-31\.md: the name must be/],
  ])("%s", (_label, files, message) => {
    const r = repo({ ...good, ...files });
    const before = r.read();
    for (const args of [[], ["--check"]]) {
      const res = r.run(...args);
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stderr).toMatch(message);
    }
    expect(r.read()).toEqual(before);
  });

  it("--check passes valid fragments and writes nothing", () => {
    const r = repo(good);
    const before = r.read();
    const res = r.run("--check");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("1 fragment(s) OK");
    expect(r.read()).toEqual(before);
  });
});

describe("changelog-assemble: the repository's own files", () => {
  it("changes/ in this repository passes --check", () => {
    const res = spawnSync(process.execPath, [ASSEMBLE, "--check"], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });

  it("assembles into copies of the real docs/CHANGELOG*.md (their Unreleased headings are the ones it expects)", () => {
    const r = repo(PAIR("40", "Security"));
    copyFileSync(join(ROOT, "docs", "CHANGELOG.md"), join(r.root, "docs", "CHANGELOG.md"));
    copyFileSync(join(ROOT, "docs", "CHANGELOG.zh-TW.md"), join(r.root, "docs", "CHANGELOG.zh-TW.md"));
    expect(r.run().status).toBe(0);
    const { en, zh } = r.read();
    const unreleased = (text: string, heading: string) => text.slice(text.indexOf(heading), text.indexOf("\n## [", text.indexOf(heading) + 1));
    expect(unreleased(en, "## [Unreleased]")).toContain("- **EN 40.** x");
    expect(unreleased(zh, "## [未發佈] (Unreleased)")).toContain("- **ZH 40。** x");
  });
});

// ── The guard ─────────────────────────────────────────────────────────────────────────────────────────────────────

type CiStep = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
// In the refactored multi-job CI (post-#1391), changelog guards live in the
// dedicated `changelog` job (no npm ci), not in the monolithic `build` job.
const ciSteps = (yaml.load(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as { jobs: { changelog: { steps: CiStep[] } } }).jobs.changelog.steps;

function gitRepo() {
  const dir = scratch("agend-changelog-guard-");
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  // The scripts come along, as in the CI checkout.
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["changelog-assemble.mjs", "changelog-guard.mjs"]) copyFileSync(join(ROOT, "scripts", f), join(dir, "scripts", f));
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git("add", "-A"); git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const base = commit("init", { "docs/CHANGELOG.md": EN, "docs/CHANGELOG.zh-TW.md": ZH, "src/a.ts": "1\n" });
  git("checkout", "-q", "-b", "pr");
  // Runs ci.yml's guard step the way Actions does: bash -e, its env, from the checkout.
  const step = ciSteps.find(s => s.name === "CHANGELOG is assembled, not edited")!;
  const guard = (baseSha: string, headSha: string) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
    cwd: dir, env: { ...env, BASE_SHA: baseSha, HEAD_SHA: headSha, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8",
  });
  return { dir, git, commit, base, guard };
}

describe("changelog-guard (ci.yml's step, on a scratch repository)", () => {
  it("the workflow runs it on pull requests only, with the PR's base and head, on a full-history checkout", () => {
    const step = ciSteps.find(s => s.name === "CHANGELOG is assembled, not edited")!;
    expect(step.if).toBe("github.event_name == 'pull_request'");
    expect(step.env).toEqual({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}" });
    expect(ciSteps.find(s => s.uses?.startsWith("actions/checkout"))?.with?.["fetch-depth"]).toBe(0);
    const check = ciSteps.find(s => s.name === "CHANGELOG fragments are valid")!;
    expect(check.run).toContain("changelog-assemble.mjs --check");
    expect(check.if).toBeUndefined();
    // Post-#1391: the changelog guard lives in its own lightweight job that
    // has no npm ci step at all (no dependencies needed), so no ordering
    // relative to npm ci applies.  Verify there is no npm ci in this job.
    expect(ciSteps.find(s => s.run === "npm ci")).toBeUndefined();
  });

  it("a PR that leaves the CHANGELOG alone (fragments only) → passes", () => {
    const r = gitRepo();
    const head = r.commit("fix: x", { "src/a.ts": "2\n", "changes/5.md": frag("Fixed", "- x"), "changes/5.zh-TW.md": frag("Fixed", "- y") });
    expect(r.guard(r.base, head).status).toBe(0);
  });

  it("a direct CHANGELOG edit → fails, naming the commit", () => {
    const r = gitRepo();
    const head = r.commit("fix: x", { "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **direct (#6).** z\n") });
    const res = r.guard(r.base, head);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error::");
    expect(res.stdout).toContain(head.slice(0, 12));
    // The zh-TW file alone counts too.
    const r2 = gitRepo();
    const head2 = r2.commit("fix: x", { "docs/CHANGELOG.zh-TW.md": ZH + "\n" });
    expect(r2.guard(r2.base, head2).status).toBe(1);
  });

  it("the assemble commit (trailer on its own line) → passes; the trailer inside a sentence does not count", () => {
    const r = gitRepo();
    const head = r.commit("chore: assemble CHANGELOG\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN + "\n", "docs/CHANGELOG.zh-TW.md": ZH + "\n" });
    expect(r.guard(r.base, head).status).toBe(0);
    const r2 = gitRepo();
    const head2 = r2.commit("fix: not the Changelog: assemble commit", { "docs/CHANGELOG.md": EN + "\n" });
    expect(r2.guard(r2.base, head2).status).toBe(1);
  });

  it("an assemble commit plus a direct edit in the same PR → fails", () => {
    const r = gitRepo();
    r.commit("chore: assemble\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN + "\n" });
    const head = r.commit("fix: also this", { "docs/CHANGELOG.md": EN + "\n\n" });
    const res = r.guard(r.base, head);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(head.slice(0, 12));
  });

  it("a merge-sync that brings main's CHANGELOG changes in → passes (counted from the merge-base)", () => {
    const r = gitRepo();
    r.commit("feat: on the branch", { "src/b.ts": "b\n" });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("old-style entry on main", { "docs/CHANGELOG.md": EN.replace("### Added\n", "### Added\n- **main (#7).** m\n") });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-edit", "main");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("a PR behind main, where main changed the CHANGELOG since → passes (the PR itself does not change it)", () => {
    const r = gitRepo();
    const head = r.commit("feat: on the branch", { "src/b.ts": "b\n" });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("entry on main", { "docs/CHANGELOG.md": EN.replace("### Added\n", "### Added\n- **main (#7).** m\n") });
    expect(r.guard(mainTip, head).status).toBe(0);
  });

  it("a CHANGELOG change made only inside a merge commit → fails", () => {
    const r = gitRepo();
    r.commit("feat: on the branch", { "src/b.ts": "b\n" });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main moves", { "src/c.ts": "c\n" });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-commit", "main");
    writeFileSync(join(r.dir, "docs", "CHANGELOG.md"), EN + "- **slipped in (#8).** e\n");
    r.git("add", "-A"); r.git("commit", "-q", "--no-edit");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(1);
  });

  it("a merge that changes the CHANGELOG itself, marked in its message (a release PR resolving a conflict) → passes", () => {
    const r = gitRepo();
    r.commit("chore: assemble\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **assembled (#9).** a\n") });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main moves", { "src/c.ts": "c\n" });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-commit", "main");
    writeFileSync(join(r.dir, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- **assembled (#9).** a\n- **resolved (#10).** r\n"));
    r.git("add", "-A"); r.git("commit", "-q", "-m", "Merge main\n\nChangelog: assemble");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("an assemble PR with an unmarked CHANGELOG edit slipped into a merge → fails, naming the entry", () => {
    const r = gitRepo();
    r.commit("chore: assemble\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **assembled (#9).** a\n") });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main moves", { "src/c.ts": "c\n" });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-commit", "main");
    writeFileSync(join(r.dir, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n", "### Fixed\n- **assembled (#9).** a\n- **slipped (#11).** s\n"));
    r.git("add", "-A"); r.git("commit", "-q", "--no-edit");
    const res = r.guard(mainTip, r.git("rev-parse", "HEAD"));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('added by no "Changelog: assemble" commit: - **slipped (#11).** s');
  });

  it("an edit that the PR itself reverts → passes (the PR does not change the CHANGELOG)", () => {
    const r = gitRepo();
    r.commit("oops", { "docs/CHANGELOG.md": EN + "x\n" });
    const head = r.commit("revert oops", { "docs/CHANGELOG.md": EN });
    expect(r.guard(r.base, head).status).toBe(0);
  });

  it("a long-lived line that edited the CHANGELOG all along lands once it moved its entries into fragments and put the files back to main's", () => {
    const r = gitRepo();
    r.commit("web: entry 1", { "docs/CHANGELOG.md": EN.replace("### Added\n", "### Added\n- **web 1.** w\n"), "src/w.ts": "1\n" });
    r.commit("web: entry 2", { "docs/CHANGELOG.zh-TW.md": ZH.replace("### 新增 (Added)\n", "### 新增 (Added)\n- **web 1。** w\n") });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main: an assembled entry\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **main (#12).** m\n") });
    r.git("checkout", "-q", "pr");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(1);               // as it stands: refused
    r.git("merge", "-q", "--no-commit", "main");                                       // 1. merge-sync (resolve: main's)
    r.git("checkout", "main", "--", "docs/CHANGELOG.md", "docs/CHANGELOG.zh-TW.md");
    r.git("commit", "-q", "--no-edit");
    r.commit("move the web line's entries into fragments", {                          // 2.
      "changes/1262-web-1.md": frag("Added", "- **web 1.** w"), "changes/1262-web-1.zh-TW.md": frag("Added", "- **web 1。** w"),
    });
    const head = r.git("rev-parse", "HEAD");
    expect(r.git("diff", "--name-only", `${mainTip}...${head}`, "--", "docs")).toBe(""); // 4. the files are main's
    expect(r.guard(mainTip, head).status).toBe(0);
    const check = spawnSync(process.execPath, [join(r.dir, "scripts", "changelog-assemble.mjs"), "--check"], { cwd: r.dir, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);                                        // 5.
  });

  // Prism #1333 r1: a conflict between the PR's assemble commit and main, resolved to one side by an unmarked merge.
  const conflicted = () => {
    const r = gitRepo();
    r.git("checkout", "-q", "main");
    r.commit("fragments land on main", { "changes/5.md": frag("Fixed", "- **five (#5).** f"), "changes/5.zh-TW.md": frag("Fixed", "- **五（#5）。** f") });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-edit", "main");
    r.git("rm", "-q", "changes/5.md", "changes/5.zh-TW.md");
    r.commit("chore: assemble\n\nChangelog: assemble", {
      "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **five (#5).** f\n"),
      "docs/CHANGELOG.zh-TW.md": ZH.replace("### 修正 (Fixed)\n", "### 修正 (Fixed)\n- **五（#5）。** f\n"),
    });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main reworded an entry\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("- **Existing fix (#2).** b", "- **Existing fix (#2).** b, reworded") });
    r.git("checkout", "-q", "pr");
    const res = spawnSync("git", ["merge", "-q", "main"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, HOME: r.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    expect(res.status, "the merge must conflict").not.toBe(0);
    return { r, mainTip };
  };

  it.each([
    ["--ours (main's reworded entry dropped)", "--ours", /removed by no "Changelog: assemble" commit[^.]*Existing fix \(#2\)\.\*\* b, reworded/],
    ["--theirs (the assembled entry dropped, its fragments already deleted)", "--theirs", /changes\/5\.md is deleted but its entry is not in the CHANGELOG/],
  ])("a conflict resolved %s in an unmarked merge → fails", (_label, side, why) => {
    const { r, mainTip } = conflicted();
    r.git("checkout", side, "--", "docs/CHANGELOG.md");
    r.git("add", "-A"); r.git("commit", "-q", "--no-edit");
    const res = r.guard(mainTip, r.git("rev-parse", "HEAD"));
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(why);
  });

  it("the same conflict, resolved to keep both and the merge marked → passes", () => {
    const { r, mainTip } = conflicted();
    writeFileSync(join(r.dir, "docs", "CHANGELOG.md"), EN.replace("### Fixed\n- **Existing fix (#2).** b", "### Fixed\n- **five (#5).** f\n- **Existing fix (#2).** b, reworded"));
    r.git("add", "-A"); r.git("commit", "-q", "-m", "Merge main\n\nChangelog: assemble");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("the conflict resolved --ours on purpose, the merge marked → passes (it vouches for what it dropped from main's side)", () => {
    const { r, mainTip } = conflicted();
    r.git("checkout", "--ours", "--", "docs/CHANGELOG.md");
    r.git("add", "-A"); r.git("commit", "-q", "-m", "Merge main, keeping ours\n\nChangelog: assemble");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("control: an assemble PR merge-synced with a main that assembled its own entries elsewhere (clean, unmarked) → passes", () => {
    const r = gitRepo();
    r.commit("chore: assemble\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Fixed\n", "### Fixed\n- **mine (#21).** a\n") });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main assembles\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Added\n", "### Added\n- **theirs (#22).** t\n"), "src/m.ts": "m\n" });
    r.git("checkout", "-q", "pr");
    r.git("merge", "-q", "--no-edit", "main");
    expect(r.guard(mainTip, r.git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("a PR that deletes someone's fragment without assembling it → fails", () => {
    const r = gitRepo();
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("fragments", { "changes/30.md": frag("Fixed", "- x"), "changes/30.zh-TW.md": frag("Fixed", "- y") });
    r.git("checkout", "-q", "pr"); r.git("merge", "-q", "--no-edit", "main");
    r.git("rm", "-q", "changes/30.md", "changes/30.zh-TW.md"); r.git("commit", "-q", "-m", "tidy");
    const res = r.guard(mainTip, r.git("rev-parse", "HEAD"));
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/changes\/30\.md is deleted but its entry is not in the CHANGELOG/);
  });

  it("an edit the PR reverted, while main moved on with CHANGELOG changes of its own → passes (counted from the merge-base)", () => {
    const r = gitRepo();
    r.commit("oops", { "docs/CHANGELOG.md": EN + "x\n" });
    const head = r.commit("revert oops", { "docs/CHANGELOG.md": EN });
    r.git("checkout", "-q", "main");
    const mainTip = r.commit("main assembles\n\nChangelog: assemble", { "docs/CHANGELOG.md": EN.replace("### Added\n", "### Added\n- **main (#40).** m\n") });
    expect(r.guard(mainTip, head).status).toBe(0);
  });

  it("missing or malformed SHAs, or ones git does not know → exit 2", () => {
    const r = gitRepo();
    expect(r.guard("", r.base).status).toBe(2);
    expect(r.guard("main", r.base).status).toBe(2);
    expect(r.guard("0".repeat(40), r.base).status).toBe(2);
  });
});

describe("changes/README.md is not a fragment", () => {
  it("exists and is skipped by the assembler", () => {
    expect(existsSync(join(ROOT, "changes", "README.md"))).toBe(true);
  });
});

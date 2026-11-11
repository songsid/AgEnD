/** Compare original records/limits/fingerprints with an owned baseline checkout. Pure diff calls, no runtime. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { settingsSummaryCases } from "../../tests/helpers/settings-summary-cases-3416.js";
const repo = resolve(process.env.REPO ?? process.cwd()), baseline = resolve(process.env.BASELINE ?? "");
if (!process.env.BASELINE || baseline === repo) throw Error("BASELINE must name an owned detached baseline checkout");
const out = resolve(process.env.OUT ?? join(repo, ".artifacts/settings-summary-page-language-3416/canonical")); mkdirSync(out, { recursive: true });
process.env.AGEND_HOME = join(out, "home"); mkdirSync(process.env.AGEND_HOME, { recursive: true, mode: 0o700 });
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const git = (at: string, ...args: string[]) => execFileSync("git", args, { cwd: at, encoding: "utf8" }).trim();
const run = async (at: string) => {
  const { settingsChangeDiff } = await import(join(at, "src/settings-change.ts")), { setLocale } = await import(join(at, "src/locale.ts"));
  const values: any[] = [];
  for (const locale of ["en", "zh-TW"] as const) {
    setLocale(locale);
    for (const c of settingsSummaryCases) {
      try {
        const diff = settingsChangeDiff(c.before, c.after, { operation: `PATCH ${c.name}`, ...c.options });
        if (!diff) values.push({ locale, name: c.name, value: null });
        else { const { summary_i18n, ...canonical } = diff; values.push({ locale, name: c.name, value: canonical }); }
      } catch (error: any) { values.push({ locale, name: c.name, error: { name: error.name, code: error.code, message: error.message } }); }
    }
  }
  return values;
};
const before = await run(baseline), after = await run(repo), identical = JSON.stringify(before) === JSON.stringify(after);
writeFileSync(join(out, "receipt.json"), JSON.stringify({ baseline: git(baseline, "rev-parse", "HEAD"), candidate: git(repo, "rev-parse", "HEAD"),
  dirty: git(repo, "status", "--porcelain", "--untracked-files=no"), sourceDigests: { baseline: hash(join(baseline, "src/settings-change.ts")), candidate: hash(join(repo, "src/settings-change.ts")), corpus: hash(join(repo, "tests/helpers/settings-summary-cases-3416.ts")), harness: hash(join(repo, "scripts/manual/settings-summary-canonical-3416.mts")) },
  cases: after.length, identical, before, after, scope: "Pure producer calls; optional display metadata excluded. Canonical strings, fingerprints, classifications, affected owners and refusals compared byte-for-byte. No account/CLI/native/runtime operation." }, null, 2) + "\n");
if (!identical) throw Error("canonical producer outputs changed");
console.log(JSON.stringify({ cases: after.length, identical }));

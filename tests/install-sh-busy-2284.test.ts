/**
 * #2284: install.sh's installer step, when the release's installer exits 75 — it could not take the install lock, and
 * has said why: most often another AgEnD install that is still running, sometimes something left behind that it names
 * (Prism: an abandoned `.reclaim` marker is one, and waiting does not clear it). So install.sh does not add "Installation
 * failed … run this installer again", nor claim an update is in progress: it says the lock could not be taken, to let a
 * running install finish if that is what the reason says, and otherwise to do what it says — in English, or in Chinese
 * by the shell's locale — and exits 75. A real failure keeps the old line. The step is run exactly as install.sh has it
 * (the marked block, under its `set -euo pipefail` and helpers), with a stub npm; its `exec` either exits with a given
 * code or runs the REAL installer against a scratch prefix.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const script = readFileSync(join(REPO, "install.sh"), "utf8");
const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
// install.sh's own helpers, as it defines them.
const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");

const dir = mkdtempSync(join(tmpdir(), "agend-2284-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// The live installer has already bootstrapped Node before entering this block.
symlinkSync(process.execPath, join(dir, "node"));
const prefix = join(dir, "prefix");
mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
writeFileSync(join(dir, "npm"), `#!/bin/sh
case "$1" in
  view) echo '{"agend":"launcher/agend","agend-install":"launcher/agend-install.cjs"}' ;;
  root) echo '${join(prefix, "lib", "node_modules")}' ;;
  prefix) echo '${prefix}' ;;
  exec)
    if [ -n "\${REAL_INSTALLER:-}" ]; then exec '${process.execPath}' '${join(REPO, "launcher", "agend-install.cjs")}'; fi
    echo "  (the release's installer ran)"; exit "\${NPM_EXEC_RC:-0}" ;;
  *) echo "unexpected npm $*" >&2; exit 9 ;;
esac
`);
chmodSync(join(dir, "npm"), 0o755);

type Env = Record<string, string>;
const run = (env: Env) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
  encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, HOME: join(dir, "home"), AGEND_HOME: join(dir, "agend-home"), ...env },
});
const NOT_TAKEN = "AgEnD was not installed this time: the install lock could not be taken (the reason is above). If it says another AgEnD install is running, let it finish; otherwise do what it says, then run this installer again.";
const NOT_TAKEN_ZH = "AgEnD 這次沒有安裝：無法取得安裝鎖（原因見上方）。如果上方說另一個 AgEnD 安裝正在進行，等它完成即可；否則照上方的說明處理，再執行一次這個安裝指令。";

describe("#2284 install.sh: an install lock that could not be taken is not reported as a failed install", () => {
  it("the marked step is install.sh's installer step, with its helpers; the website copy is identical", () => {
    expect(step).toMatch(/npm exec --yes --package "\$AGEND_SPEC" -- agend-install/);
    expect(helpers).toMatch(/^warn\(\)/m);
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });

  it("exit 75: the lock could not be taken, see the reason; no 'Installation failed', no claim that an update is in progress; exit 75", () => {
    const r = run({ NPM_EXEC_RC: "75", LANG: "C.UTF-8" });
    expect(r.status).toBe(75);
    expect(r.stdout).toContain(NOT_TAKEN);
    expect(r.stdout).not.toMatch(/Installation failed|in progress|Nothing to do/);
    expect(r.stdout).not.toContain("AFTER THE STEP");
  });

  const chinese: Env[] = [{ LANG: "zh_TW.UTF-8" }, { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, { LC_MESSAGES: "zh_TW.UTF-8" }];
  it.each(chinese)("a Chinese locale (%j): the same, in Chinese", (locale: Env) => {
    const r = run({ NPM_EXEC_RC: "75", ...locale });
    expect(r.status).toBe(75);
    expect(r.stdout).toContain(NOT_TAKEN_ZH);
    expect(r.stdout).not.toContain("Installation failed");
  });

  it("LC_ALL wins over a Chinese LANG (English then)", () => {
    expect(run({ NPM_EXEC_RC: "75", LANG: "zh_TW.UTF-8", LC_ALL: "en_US.UTF-8" }).stdout).toContain(NOT_TAKEN);
  });

  it("a real failure keeps 'Installation failed … run this installer again' (exit 1); success goes on", () => {
    const failed = run({ NPM_EXEC_RC: "1", LANG: "zh_TW.UTF-8" });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Installation failed (see above). Run this installer again");
    expect(failed.stdout).not.toContain(NOT_TAKEN_ZH);
    const ok = run({ NPM_EXEC_RC: "0" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("AFTER THE STEP");
  });

  // The REAL installer behind the block: what its 75 says, and that install.sh's line fits both kinds of reason.
  describe("with the real installer (scratch prefix; it refuses before npm installs anything)", () => {
    const lockReaders = createRequire(import.meta.url)("../launcher/install-admission.cjs") as { processStart(pid: number): string | null };
    const oldLock = (pid: number, processStart: string) => JSON.stringify({ pid, processStart, prefix, targetSpec: "@songsid/agend@2.2.6", agendHome: "/h", token: "c".repeat(32), createdAt: "2026-10-21T00:00:00.000Z" }) + "\n";
    const lock = join(prefix, ".agend-install.lock");
    const clear = () => { for (const f of [lock, `${lock}.reclaim`]) rmSync(f, { force: true }); };

    it("another install that is still running (an old updater's live lock): its pid, then 'let it finish' applies — exit 75", () => {
      clear();
      writeFileSync(lock, oldLock(process.pid, lockReaders.processStart(process.pid)!));
      const r = run({ REAL_INSTALLER: "1", LANG: "C.UTF-8" });
      expect(r.status, r.stdout + r.stderr).toBe(75);
      expect(r.stdout).toMatch(new RegExp(`another AgEnD install \\(pid ${process.pid}\\) is running`));
      expect(r.stdout).toContain(NOT_TAKEN);
      expect(r.stdout).not.toContain("Installation failed");
    });

    it("an abandoned reclaim marker (its updater gone): the installer names it and what to do; install.sh does not tell the user to wait — exit 75", () => {
      clear();
      writeFileSync(lock, oldLock(2147483647, "Mon Oct 20 10:00:00 2026"));
      writeFileSync(`${lock}.reclaim`, oldLock(2147483647, "Mon Oct 20 10:00:00 2026"));
      const r = run({ REAL_INSTALLER: "1", LANG: "C.UTF-8" });
      expect(r.status, r.stdout + r.stderr).toBe(75);
      expect(r.stdout).toMatch(/a reclaim marker .*\.reclaim was left behind \(pid 2147483647\); if no `agend update` runs, remove it and run this again/);
      expect(r.stdout).toContain(NOT_TAKEN);
      expect(r.stdout, "no claim that an update is running").not.toMatch(/update is in progress|Nothing to do/);
      clear();
    });
  });
});

/**
 * #2284: install.sh's installer step, when the release's installer exits 75 — another AgEnD update holds the install
 * lock (the installer has already said whose). Nothing broke: the user is told to let it finish, in English or in
 * Chinese by the shell's locale, and install.sh exits 75 too. A real failure keeps the "Installation failed … run this
 * installer again" line. The step is run exactly as install.sh has it (the marked block), with a stub npm.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = readFileSync(join(import.meta.dirname, "..", "install.sh"), "utf8");
const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
// install.sh's own helpers and shell options, as it defines them.
const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");

const dir = mkdtempSync(join(tmpdir(), "agend-2284-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "npm"), `#!/bin/sh
case "$1" in
  view) echo '{"agend":"launcher/agend","agend-install":"launcher/agend-install.cjs"}' ;;
  exec) echo "  (the release's installer ran)"; exit "\${NPM_EXEC_RC:-0}" ;;
esac
`);
chmodSync(join(dir, "npm"), 0o755);

const run = (rc: number, locale: Record<string, string> = {}) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
  encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, NPM_EXEC_RC: String(rc), ...locale },
});

describe("#2284 install.sh: another update holding the lock is not a failure", () => {
  it("the marked step is install.sh's installer step, with its helpers", () => {
    expect(step).toMatch(/npm exec --yes --package "\$AGEND_SPEC" -- agend-install/);
    expect(helpers).toMatch(/^warn\(\)/m);
    expect(readFileSync(join(import.meta.dirname, "..", "website", "public", "install.sh"), "utf8")).toBe(script);
  });

  it("exit 75: 'another AgEnD update is in progress … let it finish', no 'Installation failed', install.sh exits 75", () => {
    const r = run(75, { LANG: "C.UTF-8" });
    expect(r.status).toBe(75);
    expect(r.stdout).toContain("Another AgEnD update is in progress (see above). Nothing to do: let it finish.");
    expect(r.stdout).not.toContain("Installation failed");
    expect(r.stdout).not.toContain("AFTER THE STEP");
  });

  it.each([{ LANG: "zh_TW.UTF-8" }, { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, { LC_MESSAGES: "zh_TW.UTF-8" }])("a Chinese locale (%j): the same, in Chinese", locale => {
    const r = run(75, locale);
    expect(r.status).toBe(75);
    expect(r.stdout).toContain("另一個 AgEnD 更新正在進行中（見上方）。不需要做任何事，等它完成即可");
    expect(r.stdout).not.toContain("Installation failed");
  });

  it("LC_ALL wins over a Chinese LANG (English then)", () => {
    expect(run(75, { LANG: "zh_TW.UTF-8", LC_ALL: "en_US.UTF-8" }).stdout).toContain("Another AgEnD update is in progress");
  });

  it("a real failure keeps 'Installation failed … run this installer again' (exit 1); success goes on", () => {
    const failed = run(1, { LANG: "zh_TW.UTF-8" });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Installation failed (see above). Run this installer again");
    expect(failed.stdout).not.toContain("另一個 AgEnD 更新");
    const ok = run(0);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("AFTER THE STEP");
  });
});

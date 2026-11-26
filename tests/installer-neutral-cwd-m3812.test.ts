/**
 * M-3812: started inside a project with its own node_modules/.bin/node, `npm exec --package <agend> -- agend-install`
 * ran the installer on that project's node: npm exec puts the folder's node_modules/.bin first on PATH. So `agend
 * update` and install.sh could run code from whatever folder they were started in. Both now launch the installer from
 * the filesystem root. install.sh makes a relative `file:` version absolute first, against the folder it started in.
 *
 * Here: install.sh's installer step, with an npm that does what npm exec does with the folder it runs in. `agend
 * update`'s launch runs through the built CLI in tests/update-detached-1631.test.ts. Real npm 12:
 * docs/evidence/installer-neutral-cwd-m3812/.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };

/** A project folder with its own `node` in node_modules/.bin (what the npm package `node` installs); it leaves a mark. */
function project() {
  const d = scratch("agend-m3812-project-");
  mkdirSync(join(d, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "some-project", version: "1.0.0" }));
  writeFileSync(join(d, "node_modules", ".bin", "node"), `#!/bin/sh\necho "$*" > '${join(d, "project-node-ran")}'\n`);
  chmodSync(join(d, "node_modules", ".bin", "node"), 0o755);
  return { dir: d, ran: () => existsSync(join(d, "project-node-ran")) };
}

describe.skipIf(process.platform === "win32")("install.sh: the installer is launched from /", () => {
  const script = readFileSync(join(REPO, "install.sh"), "utf8");
  const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
  const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");

  /** The step, run from `cwd`, with an npm whose `exec` runs `node` the way npm exec would there (the folder's .bin first). */
  function run(cwd: string, env: Record<string, string> = {}) {
    const d = scratch("agend-m3812-sh-");
    symlinkSync(process.execPath, join(d, "node"));
    writeFileSync(join(d, "npm"), `#!/bin/sh
case "$1" in
  view) echo '{"agend":"launcher/agend","agend-install":"launcher/agend-install.cjs"}' ;;
  exec) echo "npm $* | in $PWD" >> '${join(d, "npm.log")}'; PATH="$PWD/node_modules/.bin:$PATH" node -e 0 ;;
  config) exit 0 ;;
  *) exit 9 ;;
esac
`);
    chmodSync(join(d, "npm"), 0o755);
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
      cwd, encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: "beta", ...env },
    });
    const log = () => readFileSync(join(d, "npm.log"), "utf8").trim().split("\n");
    return { r, log };
  }

  it("started inside a project with its own node: npm exec runs in /, and the project's node never runs", () => {
    const p = project();
    const { r, log } = run(p.dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log()).toEqual(["npm exec --yes --package @songsid/agend@beta -- agend-install | in /"]);
    expect(p.ran(), "the project's node never ran").toBe(false);
  });

  it("a relative file: version is made absolute against the folder the script started in; an absolute one is kept", () => {
    const p = project();
    expect(run(p.dir, { AGEND_VERSION: "file:./songsid-agend-9.9.9.tgz" }).log()).toEqual([`npm exec --yes --package @songsid/agend@file:${p.dir}/./songsid-agend-9.9.9.tgz -- agend-install | in /`]);
    expect(run(p.dir, { AGEND_VERSION: "file:/srv/agend.tgz" }).log()).toEqual(["npm exec --yes --package @songsid/agend@file:/srv/agend.tgz -- agend-install | in /"]);
  });

  it("the installer's exit code still reaches the step (75: the lock is busy)", () => {
    const p = project();
    const d = scratch("agend-m3812-sh-");
    symlinkSync(process.execPath, join(d, "node"));
    writeFileSync(join(d, "npm"), `#!/bin/sh\ncase "$1" in view) echo '{"agend-install":"x"}' ;; exec) exit 75 ;; *) exit 0 ;; esac\n`);
    chmodSync(join(d, "npm"), 0o755);
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
      cwd: p.dir, encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: "beta", LANG: "C" },
    });
    expect(r.status).toBe(75);
    expect(r.stdout + r.stderr).toContain("the install lock could not be taken");
  });

  it("the website copy is identical", () => {
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });
});

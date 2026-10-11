/**
 * #1441 part B, nvm install (#1623 review P2-1/P2-2): the npm prefix needs sudo, so the release is installed by nvm's
 * npm and runs on the Node 22 nvm selects. Neither exists before nvm has run, so the check runs inside runUpdateInstall
 * once the selection is frozen — on that exact Node, with that Node's npm — and before the prefix lock and npm install.
 *
 * Real bash/sh; `npm` on the parent PATH and nvm's `npm` are two separate stubs that answer the requirements query
 * differently, and nvm's `node` reports a chosen version to the probe. No host npm, no network, no fleet.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runUpdateInstall, type CommandRunner } from "../src/update-install.js";
import { installPreflight } from "../src/update-preflight.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const VERSION = "2.3.0-beta.1", SPEC = `@songsid/agend@${VERSION}`;
const sq = (t: string) => `'${t.replace(/'/g, "'\\''")}'`;

/** `parent` / `nvm`: what each npm answers to the requirements query (null: it fails); `nvmNode`: the selected Node's version. */
function nvmUpdate(c: { parent: object | null; nvm: object | null; nvmNode: string }) {
  const root = mkdtempSync(join(tmpdir(), "agend-1441-nvm-")); roots.push(root);
  const log = join(root, "calls.log"); writeFileSync(log, "");
  const tools = join(root, "tools"), nvmBin = join(root, "nvm", "versions", "node", `v${c.nvmNode}`, "bin");
  mkdirSync(tools, { recursive: true }); mkdirSync(nvmBin, { recursive: true });
  const npmStub = (who: string, answer: object | null) => {
    const json = join(root, `${who}.json`);
    if (answer) writeFileSync(json, JSON.stringify(answer));
    return `#!/bin/sh
echo "${who}-npm $*" >> ${sq(log)}
case "$*" in
  "view ${SPEC} version engines optionalDependencies --json") [ -f ${sq(json)} ] && exec cat ${sq(json)}; exit 1;;
  "prefix -g") echo ${sq(join(root, who))};;
esac
exit 0
`;
  };
  writeFileSync(join(tools, "npm"), npmStub("parent", c.parent));
  writeFileSync(join(nvmBin, "npm"), npmStub("nvm", c.nvm));
  writeFileSync(join(nvmBin, "node"), `#!/bin/sh
case "$*" in *"process.versions.node + ' ' + process.execPath"*) echo "${c.nvmNode} $0"; exit 0;; esac
exec ${sq(process.execPath)} "$@"
`);
  for (const f of [join(tools, "npm"), join(nvmBin, "npm"), join(nvmBin, "node")]) chmodSync(f, 0o755);
  const nvmSh = join(root, "nvm", "nvm.sh");
  writeFileSync(nvmSh, `nvm() { case "$1" in install) echo "nvm install $2" >> ${sq(log)}; return 0;; use) PATH=${sq(nvmBin)}:"$PATH"; export PATH;; esac; }\n`);
  const runner: CommandRunner = {
    run: (command, args, options = {}) => {
      const r = spawnSync(command, args, { encoding: "utf8", cwd: root, timeout: options.timeoutMs, env: { PATH: `${tools}:/usr/bin:/bin`, HOME: root, ...options.env } });
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    log: () => {},
  };
  const locked: string[] = [], printed: string[] = [];
  const outcome = runUpdateInstall({
    pkg: SPEC, targetVersion: VERSION, viaNvm: true, nvmSh,
    // The lock is the first step after the check: reaching it means the install would go on. Stop there.
    lock: prefix => { locked.push(prefix); return { ok: false, reason: "test stops at the lock" }; },
    preflight: installPreflight(SPEC, VERSION, "the Node 22 nvm selected", { log: m => printed.push(m), error: m => printed.push(m) }),
  }, runner);
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { outcome, locked, printed: printed.join("\n"), calls, nvmBin };
}
const manifest = (engines: string) => ({ version: VERSION, engines: { node: engines }, optionalDependencies: {} });

describe("#1441 B: an nvm install is judged on the Node nvm selected, with that Node's npm — before the lock and npm", () => {
  it("nvm's npm says >=24 while the parent npm says ^22.14.0: refused before the lock (Prism witness a)", () => {
    const { outcome, locked, calls, printed, nvmBin } = nvmUpdate({ parent: manifest("^22.14.0"), nvm: manifest(">=24"), nvmNode: "22.23.3" });
    expect(outcome).toEqual({ ok: false, stage: "preflight", message: expect.stringMatching(/^ {2}Not updated: v2\.3\.0-beta\.1 needs Node >=24; .*The installed AgEnD was not changed\.$/) });
    expect(locked).toEqual([]);
    expect(calls.filter(l => / install -g| prefix -g/.test(l))).toEqual([]);
    expect(calls).toContain(`nvm-npm view ${SPEC} version engines optionalDependencies --json`);
    expect(calls.some(l => l.startsWith("parent-npm view"))).toBe(false);
    expect(printed).toContain(`it would run on the Node 22 nvm selected (Node 22.23.3, ${join(nvmBin, "node")})`);
  });

  it("the reverse — the parent npm says >=24, nvm's npm says ^22.14.0: goes on to the lock (Prism witness b)", () => {
    const { outcome, locked, calls } = nvmUpdate({ parent: manifest(">=24"), nvm: manifest("^22.14.0"), nvmNode: "22.23.3" });
    expect(outcome).toMatchObject({ ok: false, stage: "lock" });
    expect(locked).toHaveLength(1);
    expect(calls.some(l => l.startsWith("parent-npm view"))).toBe(false);
  });

  it("the exact selected Node decides: 22.23.3 under ^22.24.0 is refused, 22.24.1 under it goes on (Prism P2-1)", () => {
    expect(nvmUpdate({ parent: null, nvm: manifest("^22.24.0"), nvmNode: "22.23.3" }).outcome).toMatchObject({ ok: false, stage: "preflight" });
    expect(nvmUpdate({ parent: null, nvm: manifest("^22.24.0"), nvmNode: "22.24.1" }).locked).toHaveLength(1);
  });

  it("nvm's npm cannot read the requirements (the parent npm could): unknown — goes on, saying so", () => {
    const { locked, printed } = nvmUpdate({ parent: manifest(">=24"), nvm: null, nvmNode: "22.23.3" });
    expect(locked).toHaveLength(1);
    expect(printed).toContain("requirements could not be read");
  });

  it("nvm's npm answers for another version: unknown — goes on", () => {
    const { locked } = nvmUpdate({ parent: null, nvm: { ...manifest(">=24"), version: "2.2.0" }, nvmNode: "22.23.3" });
    expect(locked).toHaveLength(1);
  });
});

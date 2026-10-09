/**
 * #1450 runtime acceptance (#1460 r5/r6, Prism's witnesses): the hop boundary judges a command with its EFFECTIVE
 * environment and cwd. Startup hooks a child may run with (NODE_OPTIONS, LD_*, DYLD_*) are the ones the hop started
 * with, wrappers that would clear or re-parse the environment are refused, and a bare service manager must resolve —
 * from the child's own cwd, empty PATH entries included — to the stub in the hop's TRUSTED directory. Every refusal
 * case runs an inert private manager that must never run; the boundary journal must name the refusal.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
const boundary = join(process.cwd(), "scripts/ci/runtime-acceptance/boundary.cjs"), guard = join(process.cwd(), "tests/support/process-guard.cjs");
const roots: string[] = [];
afterAll(() => { roots.forEach(r => rmSync(r, { recursive: true, force: true })); });
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function world() {
  const root = mkdtempSync(join(tmpdir(), "agend-boundary-r5-")); roots.push(root);
  const stubs = join(root, "guard"), privateDir = join(root, "private"), mark = join(root, "manager-ran"), log = join(root, "boundary.log"), stubMark = join(root, "stub-ran");
  mkdirSync(stubs); mkdirSync(privateDir); writeFileSync(log, "");
  for (const name of ["systemctl", "launchctl"]) {
    writeFileSync(join(stubs, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(stubMark)}\nexit 1\n`); chmodSync(join(stubs, name), 0o755);
    writeFileSync(join(privateDir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(mark)}\nexit 0\n`); chmodSync(join(privateDir, name), 0o755);
  }
  const manager = join(privateDir, "systemctl"), child = join(root, "child.cjs");
  writeFileSync(child, `if(!globalThis[Symbol.for('agend.test.process-guard')])throw Error('test guard missing');\nconst r=require('child_process').spawnSync(${JSON.stringify(manager)},['--user','restart','private-unit']);if(r.error)throw r.error;process.exit(r.status);\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), PATH: `${stubs}:${process.env.PATH}`, AGEND_BOUNDARY_LOG: log, AGEND_BOUNDARY_STUBS: stubs,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${guard} --require=${boundary}`.trim() };
  delete env.BASH_ENV; delete env.ENV; delete env.LD_PRELOAD; delete env.LD_LIBRARY_PATH;
  const run = (js: string) => {
    const result = spawnSync(process.execPath, ["-e", js], { encoding: "utf8", timeout: 10_000, cwd: root, env });
    return { result, markerRan: existsSync(mark), journal: readFileSync(log, "utf8"), stubRan: existsSync(stubMark) };
  };
  const childArgs = ["--require", guard, child];
  return { root, stubs, privateDir, manager, mark, log, stubMark, child, childArgs, env, run };
}
function refuse(r: ReturnType<ReturnType<typeof world>["run"]>) {
  assert.equal(r.markerRan, false, JSON.stringify({ status: r.result.status, markerRan: r.markerRan, journal: r.journal, stderr: r.result.stderr }));
  assert.notEqual(r.result.status, 0, r.result.stderr); assert.notEqual(r.journal, "");
}
const relay = "if(r.error)throw r.error;process.exit(r.status);";

describe("effective environment native positive controls", () => {
  it("trusted absolute stub PATH stays stubbed after changing cwd", () => {
    const w = world(), cwd = join(w.root, "other"); mkdirSync(cwd);
    const r = w.run(`const r=require('child_process').spawnSync('systemctl',['--user','show','private-unit'],{cwd:${JSON.stringify(cwd)}});${relay}`);
    assert.equal(r.result.status, 1, r.result.stderr); assert.equal(r.markerRan, false); assert.equal(r.stubRan, true); assert.equal(r.journal, "");
  });
  it("a changed direct PATH that reaches a private manager is refused", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{env:{...process.env,PATH:${JSON.stringify(w.privateDir)}}});${relay}`));
  });
  it("a guarded shell prefix PATH assignment is refused before its private manager", () => {
    const w = world(); refuse(w.run(`require('child_process').execSync(${JSON.stringify(`PATH=${quote(w.privateDir)} systemctl --user restart private-unit`)})`));
  });
  it("a guarded env PATH assignment is refused before its private manager", () => {
    const w = world(); refuse(w.run(`require('child_process').execSync(${JSON.stringify(`/usr/bin/env PATH=${quote(w.privateDir)} systemctl --user restart private-unit`)})`));
  });
  it("a passed BASH_ENV startup file is refused before its private manager", () => {
    const w = world(), startup = join(w.root, "startup.sh"); writeFileSync(startup, `${quote(w.manager)} --user restart private-unit\n`);
    refuse(w.run(`const r=require('child_process').spawnSync('/bin/bash',['--noprofile','--norc','-c','printf harmless'],{env:{...process.env,BASH_ENV:${JSON.stringify(startup)}}});${relay}`));
  });
  it("trusted inherited Node preload still blocks its child's absolute private manager", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync(process.execPath,${JSON.stringify(w.childArgs)});${relay}`));
  });
  it("dropped NODE_OPTIONS is restored before child execution", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync(process.execPath,${JSON.stringify(w.childArgs)},{env:{...process.env,NODE_OPTIONS:''}});${relay}`));
  });
  it("an ordinary qualified env wrapper retains child admission", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync('/usr/bin/env',${JSON.stringify([process.execPath, ...w.childArgs])});${relay}`));
  });
  it("an ordinary env split-string wrapper retains child admission", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync('/usr/bin/env',${JSON.stringify(["-S", [process.execPath, ...w.childArgs].map(quote).join(" ")])});${relay}`));
  });
  it("harmless native child code is admitted with the trusted preload", () => {
    const w = world(), target = join(w.root, "harmless"); const r = w.run(`const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(target)},'ok')`)}]);${relay}`);
    assert.equal(r.result.status, 0, r.result.stderr); assert.equal(readFileSync(target, "utf8"), "ok"); assert.equal(r.markerRan, false); assert.equal(r.journal, "");
  });
});

describe("remaining effective environment contract witnesses", () => {
  it("child env cannot rename a private manager directory as the hop's owned stubs", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{env:{...process.env,PATH:${JSON.stringify(w.privateDir)},AGEND_BOUNDARY_STUBS:${JSON.stringify(w.privateDir)}}});${relay}`));
  });
  it("a Node child handed another AGEND_BOUNDARY_STUBS still judges by the trusted stubs", () => {
    const w = world(), inner = `const r=require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{env:{...process.env,PATH:${JSON.stringify(w.privateDir)}}});${relay}`;
    refuse(w.run(`const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(inner)}],{env:{...process.env,AGEND_BOUNDARY_STUBS:${JSON.stringify(w.privateDir)}}});${relay}`));
  });
  it("a shell assignment to AGEND_BOUNDARY_STUBS for a Node grandchild is refused", () => {
    const w = world(), inner = `require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{env:{...process.env,PATH:${JSON.stringify(w.privateDir)}}})`;
    refuse(w.run(`require('child_process').execSync(${JSON.stringify(`AGEND_BOUNDARY_STUBS=${quote(w.privateDir)} ${quote(process.execPath)} -e ${quote(inner)}`)})`));
  });
  it("a NODE_OPTIONS that only mentions the boundary is not trusted as its preload, even at the root", () => {
    const w = world(), inner = `const r=require('child_process').spawnSync(${JSON.stringify(w.manager)},['--user','restart','private-unit']);${relay}`;
    const r = spawnSync(process.execPath, ["--require", boundary, "-e", `const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(inner)}]);${relay}`],
      { encoding: "utf8", timeout: 10_000, cwd: w.root, env: { ...w.env, NODE_OPTIONS: `--require=${guard} --conditions=${boundary}` } });
    refuse({ result: r, markerRan: existsSync(w.mark), journal: readFileSync(w.log, "utf8"), stubRan: existsSync(w.stubMark) });
  });
  for (const via of ["spawn", "execSync"]) it(`relative PATH entries are judged against the child's effective cwd (${via})`, () => {
    const w = world(), other = join(w.root, "other"), relative = join(other, "guard"); mkdirSync(relative, { recursive: true });
    writeFileSync(join(relative, "systemctl"), readFileSync(w.manager)); chmodSync(join(relative, "systemctl"), 0o755);
    const opts = `{cwd:${JSON.stringify(other)},env:{...process.env,PATH:'guard:/usr/bin:/bin'}}`;
    refuse(w.run(via === "spawn"
      ? `const c=require('child_process').spawn('systemctl',['--user','restart','private-unit'],${opts});c.on('exit',s=>process.exit(s))`
      : `require('child_process').execSync('systemctl --user restart private-unit',${opts})`));
  });
  it("relative PATH entries are judged against the child's effective cwd", () => {
    const w = world(), other = join(w.root, "other"), relative = join(other, "guard"); mkdirSync(relative, { recursive: true });
    writeFileSync(join(relative, "systemctl"), readFileSync(w.manager)); chmodSync(join(relative, "systemctl"), 0o755);
    refuse(w.run(`const r=require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{cwd:${JSON.stringify(other)},env:{...process.env,PATH:'guard:/usr/bin:/bin'}});${relay}`));
  });
  it("an empty PATH entry is the child cwd, rather than an entry the lookup may ignore", () => {
    const w = world(); refuse(w.run(`const r=require('child_process').spawnSync('systemctl',['--user','restart','private-unit'],{cwd:${JSON.stringify(w.privateDir)},env:{...process.env,PATH:${JSON.stringify(`:${w.stubs}:/usr/bin:/bin`)}}});${relay}`));
  });
  for (const split of [false, true]) it(`env ${split ? "-S '-i ...'" : "-i"} cannot erase the child's boundary while its test guard remains active`, () => {
    const w = world(), args = ["-i", process.execPath, ...w.childArgs], argv = split ? ["-S", args.map(quote).join(" ")] : args;
    refuse(w.run(`const r=require('child_process').spawnSync('/usr/bin/env',${JSON.stringify(argv)});${relay}`));
  });
  for (const via of ["spawnSync", "execFileSync"]) it(`a newly passed NODE_OPTIONS startup module (${via}) is refused before it can run`, () => {
    const w = world(), startup = join(w.root, "startup.cjs");
    writeFileSync(startup, `require('child_process').spawnSync(${JSON.stringify(w.manager)}, ['--user', 'restart', 'private-unit']);\n`);
    refuse(w.run(`try { require('child_process').${via}(process.execPath, ['-e', '0'], { env: { ...process.env, NODE_OPTIONS: ${JSON.stringify(`--require=${startup}`)} } }); } catch (e) { process.exit(3); }`));
  });
  it("mentioning the boundary in a Node condition is not proof its preload survived", () => {
    const w = world(), fake = `--require=${guard} --conditions=${boundary}`;
    refuse(w.run(`const r=require('child_process').spawnSync(process.execPath,${JSON.stringify(w.childArgs)},{env:{...process.env,NODE_OPTIONS:${JSON.stringify(fake)}}});${relay}`));
  });
  it.skipIf(process.platform !== "linux" || spawnSync("cc", ["--version"]).status !== 0)("a newly passed LD_PRELOAD cannot run a native constructor before JS admission", () => {
    const w = world(), c = join(w.root, "private-preload.c"), library = join(w.root, "private-preload.so");
    writeFileSync(c, `#include <stdlib.h>\n#include <unistd.h>\n#include <sys/wait.h>\n__attribute__((constructor)) static void fixture(void){const char*p=getenv("PRIVATE_LD_MANAGER");if(!p)return;unsetenv("LD_PRELOAD");pid_t c=fork();if(c==0){execl(p,p,"--user","restart","private-unit",(char*)0);_exit(98);}if(c>0){int s;while(waitpid(c,&s,0)<0){}}}\n`);
    const built = spawnSync("cc", ["-shared", "-fPIC", c, "-o", library], { encoding: "utf8", timeout: 10_000 }); assert.equal(built.status, 0, built.stderr);
    refuse(w.run(`const r=require('child_process').spawnSync(process.execPath,['--require',${JSON.stringify(guard)},'-e','if(!globalThis[Symbol.for("agend.test.process-guard")])throw Error("test guard missing")'],{env:{...process.env,LD_PRELOAD:${JSON.stringify(library)},PRIVATE_LD_MANAGER:${JSON.stringify(w.manager)}}});${relay}`));
  });
});

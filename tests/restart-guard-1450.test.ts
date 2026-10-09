/**
 * #1450 C6 "Restart refuses an unverified transition", path 1: the definition a manager has LOADED must start this
 * package's selected Node — named — on its canonical entry with exactly `fleet start`, and no interpreter environment.
 * The design's list: another install, a same-prefix 2.1-format unit (script argv[0], Node 20 on PATH), the right entry
 * on the wrong interpreter, an extra argument, NODE_OPTIONS, a drop-in overriding ExecStart (it is what is loaded), a
 * file changed but not reloaded — each refused; the expected tuple passes.
 */
import { describe, expect, it } from "vitest";
import { expectedTuple, guardDetached, guardLaunchd, guardSystemd, judgeTuple, type ExpectedTuple } from "../src/restart-guard.js";
import type { CommandResult } from "../src/update-install.js";

const PKG = "/usr/lib/node_modules/@songsid/agend";
const RT = `${PKG}/node_modules/@songsid/agend-node-linux-x64/bin/node`;
const expected: ExpectedTuple = { node: RT, entry: `${PKG}/dist/cli.js` };
const real: Record<string, string> = {
  [RT]: RT, [`${PKG}/dist/cli.js`]: `${PKG}/dist/cli.js`, "/usr/bin/agend": `${PKG}/launcher/agend`,
  "/opt/node20/bin/node": "/opt/node20/bin/node", "/home/u/other/dist/cli.js": "/home/u/other/dist/cli.js",
};
const deps = { realpath: (p: string) => real[p] ?? null, isExecutable: () => false };
const tuple = (argv: string[], env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" }) => ({ program: argv[0]!, argv, env });

describe("judgeTuple: the loaded definition against the expected one", () => {
  it.each([
    ["the expected tuple (control)", tuple([RT, `${PKG}/dist/cli.js`, "fleet", "start"]), null],
    ["a 2.1-format unit: the entry as a script, its Node left to PATH (Node 20)", tuple([`${PKG}/dist/cli.js`, "fleet", "start"], { PATH: "/opt/node20/bin:/usr/bin" }), "as a script"],
    ["the right entry on the wrong interpreter (a system Node, not the runtime)", tuple(["/opt/node20/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), "not the selected Node"],
    ["another install's entry", tuple([RT, "/home/u/other/dist/cli.js", "fleet", "start"]), "not /usr/lib"],
    ["an extra argument", tuple([RT, `${PKG}/dist/cli.js`, "fleet", "start", "--debug"]), "its arguments"],
    ["NODE_OPTIONS set", tuple([RT, `${PKG}/dist/cli.js`, "fleet", "start"], { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/x.js" }), "NODE_OPTIONS"],
    ["the runtime directory on PATH", tuple([RT, `${PKG}/dist/cli.js`, "fleet", "start"], { PATH: `/usr/bin:${RT.replace(/\/node$/, "")}` }), "runtime directory"],
    ["the sh launcher bin as the program", tuple(["/usr/bin/agend", "fleet", "start"]), "not the selected Node"],
  ])("%s", (_name, t, refusal) => {
    const judged = judgeTuple(t, expected, deps);
    if (refusal === null) expect(judged).toEqual({ ok: true });
    else expect(judged).toMatchObject({ ok: false, reason: expect.stringContaining(refusal) });
  });
});

/** busctl answers for one loaded unit (D-Bus), as in tests/service-activation-1449.test.ts. */
function bus(argv: string[], o: { env?: string[]; need?: boolean } = {}) {
  const json = (type: string, data: unknown) => ({ status: 0, signal: null, stderr: "", stdout: JSON.stringify({ type, data }) });
  const answers: Array<[RegExp, CommandResult]> = [
    [/LoadUnit/, json("o", ["/org/freedesktop/systemd1/unit/com_2eagend_2efleet_2eservice"])],
    [/Service ExecStart$/, json("a(sasbttttuii)", [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]])],
    [/Service EnvironmentFiles$/, json("a(sb)", [])],
    [/Service (PassEnvironment|UnsetEnvironment)$/, json("as", [])],
    [/Service Environment$/, json("as", o.env ?? ["PATH=/usr/local/bin:/usr/bin:/bin"])],
    [/Manager Environment$/, json("as", [])],
    [/NeedDaemonReload$/, json("b", o.need ?? false)],
  ];
  return (command: string, args: string[]): CommandResult => {
    const line = [command, ...args].join(" ");
    return answers.find(([re]) => re.test(line))?.[1] ?? { status: 1, signal: null, stdout: "", stderr: "unexpected" };
  };
}

describe("guardSystemd: what systemd has LOADED (drop-ins included), and no reload pending", () => {
  it("control: the expected tuple loaded → ok", () => {
    expect(guardSystemd(bus([RT, `${PKG}/dist/cli.js`, "fleet", "start"]), true, "com.agend.fleet", expected, deps)).toEqual({ ok: true });
  });
  it("a file changed but not reloaded → refused", () => {
    expect(guardSystemd(bus([RT, `${PKG}/dist/cli.js`, "fleet", "start"], { need: true }), true, "com.agend.fleet", expected, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining("not reloaded") });
  });
  it("a drop-in overriding ExecStart: the loaded (overridden) command is what is judged", () => {
    expect(guardSystemd(bus(["/opt/node20/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), true, "com.agend.fleet", expected, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining("not the selected Node") });
  });
  it("NODE_OPTIONS in the loaded environment → refused", () => {
    expect(guardSystemd(bus([RT, `${PKG}/dist/cli.js`, "fleet", "start"], { env: ["PATH=/usr/bin", "NODE_OPTIONS=--inspect"] }), true, "com.agend.fleet", expected, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining("NODE_OPTIONS") });
  });
  it("an unreadable bus → refused, never assumed", () => {
    expect(guardSystemd(() => ({ status: 1, signal: null, stdout: "", stderr: "no bus" }), true, "com.agend.fleet", expected, deps)).toMatchObject({ ok: false });
  });
});

describe("guardLaunchd: the loaded job, and the plist on disk, both", () => {
  const plist = (args: string[]) => `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict></dict></plist>`;
  const printed = (args: string[]) => (command: string, argv: string[]): CommandResult => ({
    status: command === "launchctl" && argv[0] === "print" ? 0 : 1, signal: null, stderr: "",
    stdout: [`gui/501/com.agend.fleet = {`, `\tprogram = ${args[0]}`, "\targuments = {", ...args.map(a => `\t\t${a}`), "\t}", "\tenvironment = {", "\t\tPATH => /usr/bin:/bin", "\t}", "\tstate = running", "\tpid = 777", "}"].join("\n"),
  });
  const want = [RT, `${PKG}/dist/cli.js`, "fleet", "start"];
  it("control: loaded = disk = expected → ok", () => {
    expect(guardLaunchd(printed(want), "gui/501/com.agend.fleet", "/p.plist", () => plist(want), expected, deps)).toEqual({ ok: true });
  });
  it("a proven new plist waiting on disk while the old job is loaded → refused (that is path 2's planned activation, not a restart)", () => {
    const old = [`${PKG}/dist/cli.js`, "fleet", "start"];
    expect(guardLaunchd(printed(old), "gui/501/com.agend.fleet", "/p.plist", () => plist(want), expected, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining("is not the one /p.plist describes") });
  });
  it("the old 2.1-format job loaded and on disk → refused", () => {
    const old = [`${PKG}/dist/cli.js`, "fleet", "start"];
    expect(guardLaunchd(printed(old), "gui/501/com.agend.fleet", "/p.plist", () => plist(old), expected, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining("as a script") });
  });
  it("launchctl print that does not complete → refused", () => {
    expect(guardLaunchd(() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }), "gui/501/com.agend.fleet", "/p.plist", () => plist(want), expected, deps)).toMatchObject({ ok: false });
  });
});

describe("guardDetached and the expectation itself", () => {
  it("the detached restart's Node must be the selected one", () => {
    expect(guardDetached(RT, expected, deps)).toEqual({ ok: true });
    expect(guardDetached("/opt/node20/bin/node", expected, deps)).toMatchObject({ ok: false, reason: expect.stringContaining("run it as `agend restart`") });
  });
  it("expectedTuple: this package's own launcher decides (its launcher dir beside dist/), and a refusal is passed on", () => {
    const seen: string[] = [];
    expect(expectedTuple(dir => { seen.push(dir); return { ok: true, node: RT, source: "runtime" }; }, `${PKG}/dist/cli.js`)).toEqual({ ok: true, expected: { ...expected, source: "runtime", launcher: `${PKG}/launcher/agend` } });
    expect(seen).toEqual([`${PKG}/launcher`]);
    expect(expectedTuple(() => ({ ok: false, reason: "the bundled Node is missing", recovery: "npm install -g @songsid/agend@2.2.0" }), `${PKG}/dist/cli.js`))
      .toMatchObject({ ok: false, reason: expect.stringContaining("the bundled Node is missing (to repair: npm install -g @songsid/agend@2.2.0)") });
  });
});

describe("#1450: a system Node (no bundled runtime) — the definition starts the launcher; its PATH must find the selected Node", () => {
  const LAUNCHER = `${PKG}/launcher/agend`;
  const sys: ExpectedTuple = { node: "/opt/node22/bin/node", entry: `${PKG}/dist/cli.js`, source: "system", launcher: LAUNCHER };
  const fs2 = {
    realpath: (p: string) => ({ [LAUNCHER]: LAUNCHER, "/opt/node22/bin/node": "/opt/node22/bin/node", "/opt/node20/bin/node": "/opt/node20/bin/node", [`${PKG}/dist/cli.js`]: `${PKG}/dist/cli.js` } as Record<string, string>)[p] ?? null,
    isExecutable: (p: string) => ["/opt/node22/bin/node", "/opt/node20/bin/node"].includes(p),
  };
  it.each([
    ["the launcher, its PATH finding the selected Node", tuple([LAUNCHER, "fleet", "start"], { PATH: "/opt/node22/bin:/usr/bin" }), null],
    ["the launcher, its PATH finding an old Node first", tuple([LAUNCHER, "fleet", "start"], { PATH: "/opt/node20/bin:/opt/node22/bin" }), "finds /opt/node20/bin/node"],
    ["the launcher with no PATH", tuple([LAUNCHER, "fleet", "start"], {}), "finds no node"],
    ["the system Node named (breaks when nvm removes its directory)", tuple(["/opt/node22/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), "starts the launcher"],
    ["the launcher with an extra argument", tuple([LAUNCHER, "fleet", "start", "x"], { PATH: "/opt/node22/bin" }), "its arguments"],
  ])("%s", (_n, t, refusal) => {
    const judged = judgeTuple(t, sys, fs2);
    if (refusal === null) expect(judged).toEqual({ ok: true });
    else expect(judged).toMatchObject({ ok: false, reason: expect.stringContaining(refusal) });
  });
  it("a bundled runtime is never accepted through the launcher (it must be named)", () => {
    const rt: ExpectedTuple = { node: RT, entry: `${PKG}/dist/cli.js`, source: "runtime", launcher: LAUNCHER };
    expect(judgeTuple(tuple([LAUNCHER, "fleet", "start"], { PATH: "/opt/node22/bin" }), rt, { ...fs2, realpath: (p: string) => fs2.realpath(p) ?? real[p] ?? null })).toMatchObject({ ok: false });
  });
});

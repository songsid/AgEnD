/**
 * #1449 review r3: the update activates a verified install only through the service manager's EFFECTIVE definition —
 * systemd's loaded unit (drop-ins, failed reloads), launchd's loaded job — proven to start exactly the installed bin,
 * with `fleet start`, on the verified interpreter, with no NODE_OPTIONS/NODE_PATH. Managers are modelled at their
 * command boundary (a scripted runner); nothing here contacts systemd or launchd.
 */
import { describe, expect, it } from "vitest";
import {
  activateService, parseLaunchctlPrint, parsePlist, readLoadedUnit, tupleStartsVerified,
  type ActivationDeps, type ServiceManager, type TupleDeps, type VerifiedTarget,
} from "../src/service-activation.js";
import type { CommandResult } from "../src/update-install.js";
import { systemdWords } from "../src/service-installer.js";

const PKG = "/usr/lib/node_modules/@songsid/agend";
const verified: VerifiedTarget = { dir: PKG, bin: `${PKG}/dist/cli.js`, entry: `${PKG}/dist/cli.js`, node: "/opt/node22/bin/node" };
/** A small filesystem: links, executables and shebangs. */
const fs: TupleDeps = {
  realpath: p => ({
    "/usr/bin/agend": `${PKG}/dist/cli.js`,
    [`${PKG}/dist/cli.js`]: `${PKG}/dist/cli.js`,
    [`${PKG}/dist/agent-cli.js`]: `${PKG}/dist/agent-cli.js`,
    [`${PKG}/launcher/agend`]: `${PKG}/launcher/agend`,
    [`${PKG}/launcher/agend.cjs`]: `${PKG}/launcher/agend.cjs`,
    "/home/u/src/agend/dist/cli.js": "/home/u/src/agend/dist/cli.js",
    "/opt/node22/bin/node": "/opt/node22/bin/node",
    "/usr/bin/node": "/usr/bin/node",
    "/opt/node20/bin/node": "/opt/node20/bin/node",
  } as Record<string, string>)[p] ?? null,
  readFirstLine: p => (p.endsWith(".js") || p.endsWith(".cjs") ? "#!/usr/bin/env node" : p.endsWith("/launcher/agend") ? "#!/bin/sh" : null),
  isExecutable: p => ["/opt/node22/bin/node", "/usr/bin/node", "/opt/node20/bin/node"].includes(p),
};
const tuple = (argv: string[], env: Record<string, string> = { PATH: "/opt/node22/bin:/usr/bin:/bin" }) => ({ program: argv[0]!, argv, env });

describe("parsers: what the managers report", () => {
  it("a plist on disk and launchctl print of the loaded job", () => {
    expect(parsePlist(`<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/agend</string><string>fleet</string><string>start</string></array>
      <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/node22/bin:/usr/bin</string></dict></dict></plist>`))
      .toEqual({ program: "/usr/bin/agend", argv: ["/usr/bin/agend", "fleet", "start"], env: { PATH: "/opt/node22/bin:/usr/bin" } });
    expect(parseLaunchctlPrint([
      "gui/501/com.agend.fleet = {", "\tactive count = 1", "\tstate = running", "\tprogram = /usr/bin/agend",
      "\targuments = {", "\t\t/usr/bin/agend", "\t\tfleet", "\t\tstart", "\t}",
      "\tenvironment = {", "\t\tPATH => /opt/node22/bin:/usr/bin", "\t}", "\tpid = 4242", "}",
    ].join("\n"))).toEqual({
      tuple: { program: "/usr/bin/agend", argv: ["/usr/bin/agend", "fleet", "start"], env: { PATH: "/opt/node22/bin:/usr/bin" } },
      pid: 4242, state: "running",
    });
  });
  // #1473 review: EJS writes `"` as `&#34;`; an AGEND_NODE / system path may contain one.
  it("numeric XML character references are decoded (EJS's &#34;), hex too, and &amp; only once", () => {
    const t = parsePlist(`<plist><dict><key>ProgramArguments</key><array><string>/opt/a&#34;b/node</string><string>/x/&#x27;q&#x27;/cli.js</string><string>a&amp;#34;b</string></array></dict></plist>`);
    expect(t?.argv).toEqual(['/opt/a"b/node', "/x/'q'/cli.js", "a&#34;b"]);
  });
});

describe("the activation tuple must start exactly the verified install", () => {
  it.each([
    ["the bin link, `fleet start`, env node → the verified Node", tuple(["/usr/bin/agend", "fleet", "start"]), true],
    ["the inner cli.js", tuple([`${PKG}/dist/cli.js`, "fleet", "start"]), true],
    ["the interpreter explicitly (the private runtime's format)", tuple(["/opt/node22/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), true],
    ["another entry inside the same package (agent-cli.js)", tuple([`${PKG}/dist/agent-cli.js`, "fleet", "start"]), false],
    ["another checkout", tuple(["/home/u/src/agend/dist/cli.js", "fleet", "start"]), false],
    ["a PATH whose `node` is not the verified one (an old Node first)", tuple(["/usr/bin/agend", "fleet", "start"], { PATH: "/opt/node20/bin:/opt/node22/bin" }), false],
    ["no PATH: systemd's default resolves /usr/bin/node, not the verified one", tuple(["/usr/bin/agend", "fleet", "start"], {}), false],
    ["extra arguments", tuple(["/usr/bin/agend", "fleet", "start", "--debug"]), false],
    ["NODE_OPTIONS set", tuple(["/usr/bin/agend", "fleet", "start"], { PATH: "/opt/node22/bin", NODE_OPTIONS: "--require /tmp/x.js" }), false],
    ["NODE_EXTRA_CA_CERTS set (rendered by no template: must be absent)", tuple(["/opt/node22/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"], { PATH: "/opt/node22/bin", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" }), false],
    ["AGEND_NODE set (the launcher would pick that Node)", tuple(["/opt/node22/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"], { PATH: "/opt/node22/bin", AGEND_NODE: "/opt/node20/bin/node" }), false],
    ["the explicit interpreter, but an old Node", tuple(["/opt/node20/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), false],
    ["the explicit interpreter, but another entry", tuple(["/opt/node22/bin/node", `${PKG}/dist/agent-cli.js`, "fleet", "start"]), false],
  ])("%s → %s", (_name, t, ok) => {
    expect(tupleStartsVerified(t, verified, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", fs).ok).toBe(ok);
  });
});

describe("since the launcher (#1450): the bin is the sh launcher; a service still starts the inner entry", () => {
  const launcherTarget: VerifiedTarget = { ...verified, bin: `${PKG}/launcher/agend` };
  it.each([
    ["the inner entry, `fleet start` (what `agend install` writes)", tuple([`${PKG}/dist/cli.js`, "fleet", "start"]), true],
    ["the interpreter explicitly on the inner entry", tuple(["/opt/node22/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), true],
    // A system Node (no bundled runtime): the launcher, which finds the verified Node on this PATH (#1450 leader review).
    ["the sh launcher bin itself, its PATH finding the verified Node", tuple([`${PKG}/launcher/agend`, "fleet", "start"]), true],
    ["the sh launcher bin itself, its PATH finding an old Node", tuple([`${PKG}/launcher/agend`, "fleet", "start"], { PATH: "/opt/node20/bin:/opt/node22/bin" }), false],
    ["the sh launcher bin itself, no PATH", tuple([`${PKG}/launcher/agend`, "fleet", "start"], {}), false],
    ["the sh launcher bin itself, its PATH right but AGEND_NODE naming another Node", tuple([`${PKG}/launcher/agend`, "fleet", "start"], { PATH: "/opt/node22/bin:/usr/bin:/bin", AGEND_NODE: "/opt/node20/bin/node" }), false],
    ["a Node on the JS launcher", tuple(["/opt/node22/bin/node", `${PKG}/launcher/agend.cjs`, "fleet", "start"]), false],
  ])("%s → %s", (_name, t, ok) => {
    expect(tupleStartsVerified(t, launcherTarget, "/usr/bin:/bin", fs).ok).toBe(ok);
  });
  it("a legacy target (its bin IS dist/cli.js) keeps the script rule: a shebang naming an old Node is refused, whatever PATH finds", () => {
    const legacy: VerifiedTarget = { dir: PKG, bin: `${PKG}/dist/cli.js`, entry: `${PKG}/dist/cli.js`, node: "/opt/node22/bin/node" };
    const pinnedShebang = { ...fs, readFirstLine: (p: string) => (p.endsWith("/dist/cli.js") ? "#!/opt/node20/bin/node" : fs.readFirstLine(p)) };
    expect(tupleStartsVerified(tuple([`${PKG}/dist/cli.js`, "fleet", "start"]), legacy, "/usr/bin:/bin", pinnedShebang).ok).toBe(false);
  });

  it("a bundled runtime (on no PATH) is never reached through the launcher: it must be named", () => {
    const bundled: VerifiedTarget = { ...launcherTarget, node: `${PKG}/node_modules/@songsid/agend-node-linux-x64/bin/node` };
    expect(tupleStartsVerified(tuple([`${PKG}/launcher/agend`, "fleet", "start"]), bundled, "/usr/bin:/bin", fs).ok).toBe(false);
  });
});

/** A scripted manager: answers per command line, records every call. */
function manager(answers: Array<[RegExp, Partial<CommandResult> | (() => Partial<CommandResult>)]>, files: Record<string, string> = {}, refreshWrites?: [string, string]) {
  const calls: string[] = [];
  let restarts = 0;
  // launchd: once a bootout succeeded, the job is gone — the next print says so (113) — unless a test says otherwise.
  let bootedOut = false;
  let clock = 0;
  const deps: ActivationDeps = {
    ...fs,
    run: (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      if (bootedOut && /^launchctl print/.test(line)) { bootedOut = false; return { status: 113, signal: null, stdout: "", stderr: "Could not find service" }; }
      const found = answers.find(([pattern]) => pattern.test(line))?.[1];
      const answer = typeof found === "function" ? found() : found;
      const result = { status: 0, signal: null, stdout: "", stderr: "", ...(answer ?? {}) };
      if (/^launchctl bootout/.test(line) && result.status === 0) bootedOut = true;
      return result;
    },
    sleep: () => { clock += 100; },
    monotonicNow: () => clock,
    readFile: path => files[path] ?? null,
    writeFile: (path, content) => { files[path] = content; calls.push(`write ${path}`); },
    refresh: () => { calls.push("refresh"); if (refreshWrites) files[refreshWrites[0]] = refreshWrites[1]; return { status: 0, signal: null, stdout: "", stderr: "" }; },
    restart: () => { restarts++; calls.push("restart"); },
    log: () => {},
  };
  return { deps, calls, files, restarts: () => restarts };
}

/** busctl answers for one loaded unit (D-Bus, lossless argv). */
function busFor(o: { argv: string[]; env?: string[]; envFiles?: Array<[string, boolean]>; pass?: string[]; unset?: string[]; need?: boolean; managerEnv?: string[]; execCount?: number }): Array<[RegExp, Partial<CommandResult>]> {
  const json = (type: string, data: unknown) => ({ stdout: JSON.stringify({ type, data }) });
  const exec = Array.from({ length: o.execCount ?? 1 }, () => [o.argv[0], o.argv, false, 0, 0, 0, 0, 0, 0, 0]);
  return [
    [/LoadUnit/, json("o", ["/org/freedesktop/systemd1/unit/com_2eagend_2efleet_2eservice"])],
    [/Service ExecStart$/, json("a(sasbttttuii)", exec)],
    [/Service EnvironmentFiles$/, json("a(sb)", o.envFiles ?? [])],
    [/Service PassEnvironment$/, json("as", o.pass ?? [])],
    [/Service UnsetEnvironment$/, json("as", o.unset ?? [])],
    [/Service Environment$/, json("as", o.env ?? ["PATH=/opt/node22/bin:/usr/bin:/bin"])],
    [/Manager Environment$/, json("as", o.managerEnv ?? ["HOME=/home/u", "PATH=/usr/local/bin:/usr/bin:/bin"])],
    [/Unit NeedDaemonReload$/, json("b", o.need ?? false)],
  ];
}

describe("systemd: refresh → daemon-reload → the LOADED unit (D-Bus) must start the verified install → restart", () => {
  const unit: ServiceManager = { kind: "systemd", unit: "com.agend.fleet", user: true };
  const OK = ["/usr/bin/agend", "fleet", "start"];

  it("control: loaded unit starts the verified bin on the verified Node → one restart", () => {
    const m = manager(busFor({ argv: OK }));
    expect(activateService(unit, verified, m.deps)).toEqual({ ok: true, via: "restart" });
    expect(m.calls[0]).toBe("refresh");
    expect(m.calls[1]).toBe("systemctl --user daemon-reload");
    expect(m.calls.at(-1)).toBe("restart");
    expect(m.calls.filter(c => c.startsWith("busctl")).every(c => c.startsWith("busctl --user --json=short "))).toBe(true);
  });

  it.each([
    ["a drop-in whose ExecStart starts another install", { argv: ["/home/u/src/agend/dist/cli.js", "fleet", "start"] }],
    ["NeedDaemonReload=yes (the file changed, not loaded)", { argv: OK, need: true }],
    ["an effective PATH selecting an old Node", { argv: OK, env: ["PATH=/opt/node20/bin:/opt/node22/bin"] }],
    ["another entry inside the verified package", { argv: [`${PKG}/dist/agent-cli.js`, "fleet", "start"] }],
    ["ONE argument \"fleet start\" (systemctl show would print it like two)", { argv: ["/usr/bin/agend", "fleet start"] }],
    ["an EnvironmentFile= (its PATH/NODE_OPTIONS cannot be proven)", { argv: OK, envFiles: [["/etc/agend.env", false]] as Array<[string, boolean]> }],
    ["PassEnvironment=", { argv: OK, pass: ["NODE_OPTIONS"] }],
    ["the manager's environment carries NODE_OPTIONS", { argv: OK, managerEnv: ["PATH=/usr/bin:/bin", "NODE_OPTIONS=--require /tmp/x.js"] }],
    ["no unit PATH: the manager's PATH resolves an old Node", { argv: OK, env: [], managerEnv: ["PATH=/opt/node20/bin:/usr/bin"] }],
    ["two ExecStart lines", { argv: OK, execCount: 2 }],
  ] as const)("%s → refused, nothing restarted", (_name, o) => {
    const m = manager(busFor(o as any));
    expect(activateService(unit, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.restarts()).toBe(0);
  });

  it("UnsetEnvironment=PATH (PATH absent in the final environment) is refused — no default is assumed", () => {
    const m = manager(busFor({ argv: OK, env: ["PATH=/opt/node22/bin:/usr/bin"], unset: ["PATH"], managerEnv: ["PATH=/opt/node22/bin"] }));
    expect(activateService(unit, verified, m.deps)).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("no PATH") });
    expect(m.restarts()).toBe(0);
  });

  it("a failed daemon-reload refuses, even when what is loaded would match", () => {
    const m = manager([[/daemon-reload/, { status: 1, stderr: "Failed" }], ...busFor({ argv: OK })]);
    expect(activateService(unit, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.restarts()).toBe(0);
  });

  it("UnsetEnvironment= removing the manager's NODE_OPTIONS, and the manager PATH resolving the verified Node, is fine", () => {
    const m = manager(busFor({ argv: OK, env: [], unset: ["NODE_OPTIONS"], managerEnv: ["PATH=/opt/node22/bin:/usr/bin", "NODE_OPTIONS=--inspect"] }));
    expect(activateService(unit, verified, m.deps)).toEqual({ ok: true, via: "restart" });
  });

  it("a system unit is reloaded and read without --user", () => {
    const m = manager(busFor({ argv: OK }));
    activateService({ kind: "systemd", unit: "agend", user: false }, verified, m.deps);
    expect(m.calls).toContain("systemctl daemon-reload");
    expect(m.calls.some(c => c.startsWith("busctl --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s agend.service"))).toBe(true);
  });

  it("readLoadedUnit keeps argv elements exactly", () => {
    const run = (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(" ");
      const hit = busFor({ argv: ["/usr/bin/agend", "fleet start", "x y"] }).find(([p]) => p.test(line))?.[1];
      return { status: 0, signal: null, stdout: "", stderr: "", ...(hit ?? {}) };
    };
    const read = readLoadedUnit(run, true, "com.agend.fleet");
    expect(read.ok && read.unit.tuple.argv).toEqual(["/usr/bin/agend", "fleet start", "x y"]);
  });
});

describe("#1450 C6: a systemd failure before the restart restores the unit (reloaded, proven) and the package", () => {
  const unitPath = "/home/u/.config/systemd/user/com.agend.fleet.service";
  const OLD = `[Service]\nExecStart=/opt/node22/bin/node ${PKG}/dist/cli.js fleet start\nEnvironment=PATH=/opt/node22/bin:/usr/bin:/bin\n`;
  const NEW_WRONG = `[Service]\nExecStart=/opt/node22/bin/node ${PKG}/dist/agent-cli.js fleet start\nEnvironment=PATH=/opt/node22/bin:/usr/bin:/bin\n`;
  /** A systemd whose LOADED ExecStart is whatever the unit file says at the last successful daemon-reload. */
  function systemd(reloads: Array<number>) {
    const files: Record<string, string> = { [unitPath]: OLD };
    let loadedText = OLD;
    let n = 0;
    const exec = () => {
      const argv = systemdWords(/^ExecStart=(.*)$/m.exec(loadedText)![1]!);
      return { stdout: JSON.stringify({ type: "a(sasbttttuii)", data: [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]] }) };
    };
    const answers: Array<[RegExp, Partial<CommandResult> | (() => Partial<CommandResult>)]> = [
      [/daemon-reload/, () => { const status = reloads[n++] ?? 0; if (status === 0) loadedText = files[unitPath]!; return { status }; }],
      [/Service ExecStart$/, exec],
      ...busFor({ argv: [] }).filter(([re]) => !/ExecStart/.test(String(re))),
    ];
    const m = manager(answers, files, [unitPath, NEW_WRONG]);
    const restored: string[] = [];
    m.deps.restorePackage = () => { restored.push("package"); m.calls.push("restore-package"); return "The previous package (v2.1.12) is back in place"; };
    return { m, restored };
  }

  it("the refreshed unit does not verify: the preimage goes back, is reloaded and loaded, and the package is restored", () => {
    const { m, restored } = systemd([0, 0]);
    const outcome = activateService({ kind: "systemd", unit: "com.agend.fleet", user: true, unitPath }, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("the previous com.agend.fleet is back and loaded; The previous package (v2.1.12) is back in place") });
    expect(m.files[unitPath]).toBe(OLD);
    expect(m.calls.filter(c => c === "systemctl --user daemon-reload")).toHaveLength(2);
    expect(restored).toEqual(["package"]);
    expect(m.restarts()).toBe(0);
  });

  it("the restore cannot be reloaded: said so, never called loaded", () => {
    const { m } = systemd([0, 1]);                         // the refresh reloads; the restore's reload fails
    const outcome = activateService({ kind: "systemd", unit: "com.agend.fleet", user: true, unitPath }, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("back on disk but systemd does not show it loaded") });
    expect(m.files[unitPath]).toBe(OLD);
  });
});

describe("launchd: loaded job = its plist, prove the new plist, ONE bootout+bootstrap, prove the loaded job; proven rollback", () => {
  const plistPath = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
  const job: ServiceManager = { kind: "launchd", label: "com.agend.fleet", plistPath, domain: "gui/501" };
  const plist = (exec: string) => `<plist><dict><key>ProgramArguments</key><array>${exec.split(" ").map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/node22/bin:/usr/bin</string></dict></dict></plist>`;
  const printed = (exec: string, pid: number | null = 777, state = "running") => ({
    stdout: ["gui/501/com.agend.fleet = {", `\tstate = ${state}`, `\tprogram = ${exec.split(" ")[0]}`, "\targuments = {", ...exec.split(" ").map(a => `\t\t${a}`), "\t}",
      "\tenvironment = {", "\t\tPATH => /opt/node22/bin:/usr/bin", "\t}", ...(pid ? [`\tpid = ${pid}`] : []), "}"].join("\n"),
  });
  const OLD = "/home/u/src/agend/dist/cli.js fleet start";       // the job running before (its own plist on disk)
  const NEW = "/usr/bin/agend fleet start";
  const OTHER = "/opt/unrelated/bin/tool fleet start";
  /** Answers each `launchctl print` in turn. */
  const prints = (...answers: Array<Partial<CommandResult>>) => { let i = 0; return () => answers[Math.min(i++, answers.length - 1)]!; };

  it("control: one bootout, one bootstrap, the loaded job starts the verified install — no kickstart, no restart", () => {
    const m = manager([[/print/, prints(printed(OLD), printed(NEW))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toEqual({ ok: true, via: "launchd-activation" });
    expect(m.calls.filter(c => /bootout|bootstrap|kickstart/.test(c))).toEqual(["launchctl bootout gui/501/com.agend.fleet", `launchctl bootstrap gui/501 ${plistPath}`]);
    expect(m.restarts()).toBe(0);
  });

  it("the loaded job is NOT what the plist on disk describes → refused before anything is stopped or rewritten", () => {
    const m = manager([[/print/, printed(OTHER)], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
    expect(m.calls).not.toContain("refresh");
  });

  it("launchd's own environment sets NODE_OPTIONS → refused before anything", () => {
    const m = manager([[/getenv NODE_OPTIONS/, { stdout: "--require /tmp/x.js\n" }], [/print/, printed(OLD)]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  it("a refreshed plist that does not start the verified install: preimage restored, launchd untouched", () => {
    const m = manager([[/print/, printed(OLD)], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(`${PKG}/dist/agent-cli.js fleet start`)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.files[plistPath]).toBe(plist(OLD));
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  it("the new job does not prove out → the preimage job is back AND proven (its tuple, running)", () => {
    const m = manager([[/print/, prints(printed(OLD), printed(OLD, 801), printed(OLD, 802))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: true });
    expect(!outcome.ok && outcome.message).toContain("Rolled back to the previous job, which is running");
    expect(m.files[plistPath]).toBe(plist(OLD));
  });

  it("recovery is NOT claimed for a pid of some other job", () => {
    let boots = 0;
    const m = manager([
      [/bootstrap/, () => (boots++ === 0 ? { status: 5 } : {})],
      [/print/, prints(printed(OLD), printed(OTHER, 999))],
      [/getenv/, { stdout: "" }],
    ], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("could NOT be restored") });
  });

  it("the new job loads but never starts (no pid) → rolled back", () => {
    const m = manager([[/print/, prints(printed(OLD), printed(NEW, null, "waiting"), printed(OLD, 803))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("did not start") });
  });

  const killed = { status: null, signal: "SIGTERM" as NodeJS.Signals };

  it("a launchctl getenv that did not complete (timed out) is uncertainty: refused, nothing touched", () => {
    const m = manager([[/getenv/, killed], [/print/, printed(OLD)]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("could not be read (launchctl getenv") });
    expect(m.calls).not.toContain("refresh");
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  it("an initial launchctl print that did not complete is NOT 'no job loaded': refused, nothing touched", () => {
    const m = manager([[/print/, killed], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("Could not tell whether") });
    expect(m.calls).not.toContain("refresh");
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
    expect(m.files[plistPath]).toBe(plist(OLD));
  });

  // #1473 review: every refusal comes after npm replaced the package — each one puts the previous package back.
  it.each([
    ["launchctl getenv did not complete", [[/getenv/, killed], [/print/, printed(OLD)]]],
    ["launchd's environment injects AGEND_NODE", [[/getenv AGEND_NODE/, { stdout: "/opt/node20/bin/node\n" }], [/getenv/, { stdout: "" }], [/print/, printed(OLD)]]],
    ["the initial launchctl print did not complete", [[/print/, killed], [/getenv/, { stdout: "" }]]],
    ["the loaded job is not the plist on disk (no owned preimage)", [[/print/, printed(OTHER)], [/getenv/, { stdout: "" }]]],
  ] as Array<[string, Array<[RegExp, Partial<CommandResult>]>]>)("an early launchd refusal (%s) restores the previous package", (_n, answers) => {
    const m = manager(answers, { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    let restored = 0;
    m.deps.restorePackage = () => { restored++; return "The previous package (v2.1.12) is back in place"; };
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("The previous package (v2.1.12) is back in place") });
    expect(restored).toBe(1);
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  it.each(["NODE_EXTRA_CA_CERTS", "AGEND_NODE"])("launchd's own environment sets %s → refused before anything", key => {
    const m = manager([[new RegExp(`getenv ${key}`), { stdout: "/x\n" }], [/getenv/, { stdout: "" }], [/print/, printed(OLD)]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining(key) });
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  // Real launchd (macOS 15, native-c6): bootout returns before the job is unloaded; a bootstrap then fails with 5.
  it("bootout is asynchronous: the bootstrap waits until launchd reports the job gone (113)", () => {
    let polls = 0;
    const m = manager([[/print/, prints(printed(OLD), printed(NEW))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const run = m.deps.run;
    let stillThere = 0;
    m.deps.run = (command, args) => {
      if (args[0] === "bootout") stillThere = 2;                    // two polls still show the old job
      if (args[0] === "print" && stillThere > 0) { stillThere--; polls++; m.calls.push("print (still loaded)"); return { status: 0, signal: null, stderr: "", ...printed(OLD) } as CommandResult; }
      return run(command, args);
    };
    expect(activateService(job, verified, m.deps)).toEqual({ ok: true, via: "launchd-activation" });
    expect(polls).toBe(2);
    const order = m.calls.filter(c => /bootout|bootstrap|still loaded|print gui/.test(c));
    expect(order.indexOf(`launchctl bootstrap gui/501 ${plistPath}`)).toBeGreaterThan(order.lastIndexOf("print (still loaded)"));
  });
  it.each(["xpcproxy", "spawn scheduled"])("right after a bootstrap the job is still spawning (%s): waited out, then judged", state => {
    const m = manager([[/print/, prints(printed(OLD), printed(NEW, 900, state), printed(NEW, 900, state), printed(NEW, 900))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toEqual({ ok: true, via: "launchd-activation" });
  });
  it("a job that never finishes unloading: no bootstrap into it; rolled back, package back", () => {
    const m = manager([[/print/, printed(OLD)], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const run = m.deps.run;
    m.deps.run = (command, args) => (args[0] === "print" && m.calls.some(c => /bootout/.test(c)) ? (m.calls.push("print (still loaded)"), { status: 0, signal: null, stderr: "", ...printed(OLD) } as CommandResult) : run(command, args));
    let restored = 0;
    m.deps.restorePackage = () => { restored++; return "package back"; };
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("did not finish unloading") });
    expect(m.calls.filter(c => /bootstrap/.test(c))).toEqual([]);
    expect(restored).toBe(1);
  });

  it("an initial print that exits non-zero for another reason (not 113) is uncertainty too", () => {
    const m = manager([[/print/, { status: 5 }], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.calls.some(c => /bootout|bootstrap/.test(c))).toBe(false);
  });

  it("a post-bootstrap print killed mid-way (matching partial output) is not success: rolled back", () => {
    const m = manager([[/print/, prints(printed(OLD), { ...printed(NEW), ...killed }, printed(OLD, 804))], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("did not complete") });
    expect(m.files[plistPath]).toBe(plist(OLD));
  });

  it("a bootout that does not complete: the old job is left, its plist restored, nothing bootstrapped", () => {
    const m = manager([[/bootout/, killed], [/print/, printed(OLD)], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("bootout") });
    expect(m.calls.some(c => /bootstrap/.test(c))).toBe(false);
    expect(m.files[plistPath]).toBe(plist(OLD));
  });

  it("nothing was loaded before: no bootout first; a failed activation restores only the plist file", () => {
    let boots = 0;
    const m = manager([[/print/, () => ({ status: 113, stdout: "" })], [/bootstrap/, () => (boots++ === 0 ? { status: 5 } : {})], [/getenv/, { stdout: "" }]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: false, message: expect.stringContaining("No job was running before") });
    expect(m.calls.filter(c => /bootstrap/.test(c))).toHaveLength(1);
    expect(m.files[plistPath]).toBe(plist(OLD));
  });
});

describe("detached: no service manager", () => {
  it("restarts through the verified binary", () => {
    const m = manager([]);
    expect(activateService({ kind: "detached" }, verified, m.deps)).toEqual({ ok: true, via: "restart" });
    expect(m.calls).toEqual(["refresh", "restart"]);
  });
});

/**
 * #1449 review r3: the update activates a verified install only through the service manager's EFFECTIVE definition —
 * systemd's loaded unit (drop-ins, failed reloads), launchd's loaded job — proven to start exactly the installed bin,
 * with `fleet start`, on the verified interpreter, with no NODE_OPTIONS/NODE_PATH. Managers are modelled at their
 * command boundary (a scripted runner); nothing here contacts systemd or launchd.
 */
import { describe, expect, it } from "vitest";
import {
  activateService, parseLaunchctlPrint, parsePlist, parseSystemdShow, tupleStartsVerified,
  type ActivationDeps, type ServiceManager, type TupleDeps, type VerifiedTarget,
} from "../src/service-activation.js";
import type { CommandResult } from "../src/update-install.js";

const PKG = "/usr/lib/node_modules/@songsid/agend";
const verified: VerifiedTarget = { dir: PKG, bin: `${PKG}/dist/cli.js`, node: "/opt/node22/bin/node" };
/** A small filesystem: links, executables and shebangs. */
const fs: TupleDeps = {
  realpath: p => ({
    "/usr/bin/agend": `${PKG}/dist/cli.js`,
    [`${PKG}/dist/cli.js`]: `${PKG}/dist/cli.js`,
    [`${PKG}/dist/agent-cli.js`]: `${PKG}/dist/agent-cli.js`,
    "/home/u/src/agend/dist/cli.js": "/home/u/src/agend/dist/cli.js",
    "/opt/node22/bin/node": "/opt/node22/bin/node",
    "/usr/bin/node": "/usr/bin/node",
    "/opt/node20/bin/node": "/opt/node20/bin/node",
  } as Record<string, string>)[p] ?? null,
  readFirstLine: p => (p.endsWith(".js") ? "#!/usr/bin/env node" : null),
  isExecutable: p => ["/opt/node22/bin/node", "/usr/bin/node", "/opt/node20/bin/node"].includes(p),
};
const tuple = (argv: string[], env: Record<string, string> = { PATH: "/opt/node22/bin:/usr/bin:/bin" }) => ({ program: argv[0]!, argv, env });

describe("parsers: what the managers report", () => {
  it("systemctl show: the loaded ExecStart, its environment (quoted values), and NeedDaemonReload", () => {
    const shown = parseSystemdShow([
      "ExecStart={ path=/usr/bin/agend ; argv[]=/usr/bin/agend fleet start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }",
      'Environment=PATH=/opt/node22/bin:/usr/bin "TITLE=a b" TERM=xterm-256color',
      "NeedDaemonReload=no",
    ].join("\n"));
    expect(shown).toEqual({
      tuple: { program: "/usr/bin/agend", argv: ["/usr/bin/agend", "fleet", "start"], env: { PATH: "/opt/node22/bin:/usr/bin", TITLE: "a b", TERM: "xterm-256color" } },
      needDaemonReload: false, execStarts: 1,
    });
    expect(parseSystemdShow("ExecStart=\nNeedDaemonReload=yes").needDaemonReload).toBe(true);
  });

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
    ["the explicit interpreter, but an old Node", tuple(["/opt/node20/bin/node", `${PKG}/dist/cli.js`, "fleet", "start"]), false],
    ["the explicit interpreter, but another entry", tuple(["/opt/node22/bin/node", `${PKG}/dist/agent-cli.js`, "fleet", "start"]), false],
  ])("%s → %s", (_name, t, ok) => {
    expect(tupleStartsVerified(t, verified, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", fs).ok).toBe(ok);
  });
});

/** A scripted manager: answers per command line, records every call. */
function manager(answers: Array<[RegExp, Partial<CommandResult> | (() => Partial<CommandResult>)]>, files: Record<string, string> = {}, refreshWrites?: [string, string]) {
  const calls: string[] = [];
  let restarts = 0;
  const deps: ActivationDeps = {
    ...fs,
    run: (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const found = answers.find(([pattern]) => pattern.test(line))?.[1];
      const answer = typeof found === "function" ? found() : found;
      return { status: 0, signal: null, stdout: "", stderr: "", ...(answer ?? {}) };
    },
    readFile: path => files[path] ?? null,
    writeFile: (path, content) => { files[path] = content; calls.push(`write ${path}`); },
    refresh: () => { calls.push("refresh"); if (refreshWrites) files[refreshWrites[0]] = refreshWrites[1]; return { status: 0, signal: null, stdout: "", stderr: "" }; },
    restart: () => { restarts++; calls.push("restart"); },
    log: () => {},
  };
  return { deps, calls, files, restarts: () => restarts };
}

const showFor = (exec: string, env = "PATH=/opt/node22/bin:/usr/bin:/bin", need = "no") => ({
  stdout: `ExecStart={ path=${exec.split(" ")[0]} ; argv[]=${exec} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\nEnvironment=${env}\nNeedDaemonReload=${need}\n`,
});

describe("systemd: refresh → daemon-reload → the LOADED unit must start the verified install → restart", () => {
  const unit: ServiceManager = { kind: "systemd", unit: "com.agend.fleet", user: true };

  it("control: loaded unit starts the verified bin on the verified Node → one restart", () => {
    const m = manager([[/show/, showFor("/usr/bin/agend fleet start")]]);
    expect(activateService(unit, verified, m.deps)).toEqual({ ok: true, via: "restart" });
    expect(m.calls).toEqual(["refresh", "systemctl --user daemon-reload", "systemctl --user show -p ExecStart -p Environment -p NeedDaemonReload com.agend.fleet", "restart"]);
  });

  it.each([
    ["a drop-in whose ExecStart starts another install", [[/show/, showFor("/home/u/src/agend/dist/cli.js fleet start")]]],
    ["a failed daemon-reload (systemd keeps the old unit)", [[/daemon-reload/, { status: 1, stderr: "Failed" }], [/show/, showFor("/home/u/src/agend/dist/cli.js fleet start")]]],
    ["a failed daemon-reload, even when what is loaded would match (the transition failed)", [[/daemon-reload/, { status: 1, stderr: "Failed" }], [/show/, showFor("/usr/bin/agend fleet start")]]],
    ["NeedDaemonReload=yes (the file changed, not loaded)", [[/show/, showFor("/usr/bin/agend fleet start", "PATH=/opt/node22/bin", "yes")]]],
    ["an effective PATH selecting an old Node", [[/show/, showFor("/usr/bin/agend fleet start", "PATH=/opt/node20/bin:/opt/node22/bin")]]],
    ["another entry inside the verified package", [[/show/, showFor(`${PKG}/dist/agent-cli.js fleet start`)]]],
    ["an unreadable show", [[/show/, { status: 1 }]]],
  ] as const)("%s → refused, nothing restarted", (_name, answers) => {
    const m = manager(answers as any);
    const outcome = activateService(unit, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: false });
    expect(m.restarts()).toBe(0);
  });

  it("a system unit is reloaded and read without --user", () => {
    const m = manager([[/show/, showFor("/usr/bin/agend fleet start")]]);
    activateService({ kind: "systemd", unit: "agend", user: false }, verified, m.deps);
    expect(m.calls).toContain("systemctl daemon-reload");
    expect(m.calls).toContain("systemctl show -p ExecStart -p Environment -p NeedDaemonReload agend");
  });
});

describe("launchd: prove the disk plist, ONE bootout+bootstrap, prove the loaded job; roll back to the preimage job", () => {
  const plistPath = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
  const job: ServiceManager = { kind: "launchd", label: "com.agend.fleet", plistPath, domain: "gui/501" };
  const plist = (exec: string) => `<plist><dict><key>ProgramArguments</key><array>${exec.split(" ").map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/node22/bin:/usr/bin</string></dict></dict></plist>`;
  const printed = (exec: string, pid: number | null = 777) => ({
    stdout: ["gui/501/com.agend.fleet = {", "\tstate = running", `\tprogram = ${exec.split(" ")[0]}`, "\targuments = {", ...exec.split(" ").map(a => `\t\t${a}`), "\t}",
      "\tenvironment = {", "\t\tPATH => /opt/node22/bin:/usr/bin", "\t}", ...(pid ? [`\tpid = ${pid}`] : []), "}"].join("\n"),
  });
  const OLD = "/home/u/src/agend/dist/cli.js fleet start";
  const NEW = "/usr/bin/agend fleet start";

  it("control: one bootout, one bootstrap, the loaded job starts the verified install — no kickstart, no restart", () => {
    const m = manager([[/print/, printed(NEW)]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toEqual({ ok: true, via: "launchd-activation" });
    expect(m.calls.filter(c => c.startsWith("launchctl"))).toEqual([
      "launchctl bootout gui/501/com.agend.fleet", `launchctl bootstrap gui/501 ${plistPath}`, "launchctl print gui/501/com.agend.fleet",
    ]);
    expect(m.calls.some(c => /kickstart/.test(c))).toBe(false);
    expect(m.restarts()).toBe(0);
  });

  it("a refreshed plist that does not start the verified install: preimage restored, launchd untouched", () => {
    const m = manager([], { [plistPath]: plist(OLD) }, [plistPath, plist(`${PKG}/dist/agent-cli.js fleet start`)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: false });
    expect(m.files[plistPath]).toBe(plist(OLD));
    expect(m.calls.some(c => c.startsWith("launchctl"))).toBe(false);
  });

  it("launchd keeps (or loads) the cached old job after the bootstrap → rolled back to the preimage job", () => {
    let prints = 0;
    const m = manager([[/print/, () => (prints++ === 0 ? printed(OLD) : printed(OLD, 888))]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    const outcome = activateService(job, verified, m.deps);
    expect(outcome).toMatchObject({ ok: false, stopped: true });
    expect(!outcome.ok && outcome.message).toContain("Rolled back to the previous job");
    expect(m.files[plistPath]).toBe(plist(OLD));
    expect(m.calls.filter(c => /bootstrap/.test(c))).toHaveLength(2);           // the new job, then the preimage
    expect(m.calls.some(c => /kickstart/.test(c))).toBe(false);
  });

  it("a failed bootstrap → rolled back to the preimage job", () => {
    let boots = 0;
    const m = manager([[/bootstrap/, () => (boots++ === 0 ? { status: 5 } : {})], [/print/, printed(OLD)]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("launchctl bootstrap failed") });
    expect(m.files[plistPath]).toBe(plist(OLD));
  });

  it("the new job loads but never starts (no pid) → rolled back", () => {
    let prints = 0;
    const m = manager([[/print/, () => (prints++ === 0 ? printed(NEW, null) : printed(OLD))]], { [plistPath]: plist(OLD) }, [plistPath, plist(NEW)]);
    expect(activateService(job, verified, m.deps)).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("did not start") });
  });
});

describe("detached: no service manager", () => {
  it("restarts through the verified binary", () => {
    const m = manager([]);
    expect(activateService({ kind: "detached" }, verified, m.deps)).toEqual({ ok: true, via: "restart" });
    expect(m.calls).toEqual(["refresh", "restart"]);
  });
});

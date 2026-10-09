/** Private files plus a scripted manager. No child process or service manager is invoked. */
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemdWords } from "../../src/service-installer.js";
import { restorePackagePreimage, takePackagePreimage } from "../../src/package-preimage.js";
import type { ActivationDeps, VerifiedTarget } from "../../src/service-activation.js";
import type { CommandResult } from "../../src/update-install.js";

export function activationWorld(root: string) {
  const prefix = join(root, "prefix"), npmRoot = join(prefix, "lib/node_modules"), pkg = join(npmRoot, "@songsid/agend");
  const entry = join(pkg, "dist/cli.js"), oldNode = join(pkg, "old/node"), newNode = join(pkg, "new/node");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const packageFiles = (version: string, node: string) => {
    mkdirSync(join(pkg, "dist"), { recursive: true }); mkdirSync(join(node, ".."), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version }));
    for (const file of [entry, node]) { writeFileSync(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o700); }
  };
  packageFiles("2.1.12", oldNode); symlinkSync(entry, join(prefix, "bin/agend"));
  const taken = takePackagePreimage(npmRoot, prefix, new Date("2026-10-10T00:00:00Z"));
  if (!taken.ok || !taken.preimage) throw Error("private preimage fixture failed");
  const preimage = taken.preimage;
  const olderBackup = join(prefix, ".agend-rollback/older"); mkdirSync(olderBackup); writeFileSync(join(olderBackup, "keep"), "earlier repair copy");
  rmSync(pkg, { recursive: true }); packageFiles("2.2.0", newNode);
  const unitPath = join(root, "unit.service");
  const unit = (node: string) => `[Service]\nType=notify\nExecStart="${node}" "${entry}" fleet start\nEnvironment=PATH=/usr/bin:/bin\nTimeoutStopSec=300\nKillMode=mixed\n`;
  const oldUnit = unit(oldNode), newUnit = unit(newNode); writeFileSync(unitPath, oldUnit, { mode: 0o600 });
  let loaded = oldUnit;
  let loadedArgv: string[] | undefined;
  let managerEnv: string[] = [];
  const state = { active: "active", sub: "running", pid: 111, control: 0, job: 0, type: "notify", killMode: "mixed", sendSigkill: true };
  const calls: string[] = [];
  let restart: "restarted" | "pending" | "failed" = "failed", stopStatus = 0, startStatus = 0, reloadStatus = 0;
  let hook: ((command: string, args: string[]) => void) | undefined;
  const result = (status = 0, stdout = ""): CommandResult => ({ status, signal: null, stdout, stderr: "" });
  const json = (type: string, data: unknown) => result(0, JSON.stringify({ type, data }));
  const run = (command: string, args: string[]): CommandResult => {
    calls.push([command, ...args].join(" ")); hook?.(command, args);
    if (command === "systemctl") {
      const action = args.filter(x => x !== "--user")[0];
      if (action === "daemon-reload") { if (reloadStatus === 0) loaded = readFileSync(unitPath, "utf8"); return result(reloadStatus); }
      if (action === "stop") { if (stopStatus === 0) Object.assign(state, { active: "inactive", sub: "dead", pid: 0, control: 0, job: 0 }); return result(stopStatus); }
      if (action === "start") { if (startStatus === 0) Object.assign(state, { active: "active", sub: "running", pid: 222, control: 0, job: 0 }); return result(startStatus); }
      throw Error(`unexpected inert systemctl action ${action}`);
    }
    if (command !== "busctl") throw Error(`unexpected inert command ${command}`);
    if (args.includes("LoadUnit")) return json("o", ["/org/freedesktop/systemd1/unit/private"]);
    const property = args.at(-1);
    if (property === "ExecStart") {
      const argv = loadedArgv ?? systemdWords(/^ExecStart=(.*)$/m.exec(loaded)?.[1] ?? "");
      return json("a(sasbttttuii)", [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]]);
    }
    if (property === "Environment") return json("as", args.includes("org.freedesktop.systemd1.Manager") ? managerEnv : ["PATH=/usr/bin:/bin"]);
    if (["EnvironmentFiles", "PassEnvironment", "UnsetEnvironment"].includes(property!)) return json("as", []);
    if (property === "NeedDaemonReload") return json("b", loaded !== readFileSync(unitPath, "utf8"));
    if (property === "ActiveState") return json("s", state.active);
    if (property === "SubState") return json("s", state.sub);
    if (property === "MainPID") return json("u", state.pid);
    if (property === "ControlPID") return json("u", state.control);
    if (property === "Type") return json("s", state.type);
    if (property === "KillMode") return json("s", state.killMode);
    if (property === "SendSIGKILL") return json("b", state.sendSigkill);
    if (property === "Job") return json("(uo)", [state.job, state.job ? "/org/freedesktop/systemd1/job/1" : "/"]);
    throw Error(`unexpected inert bus property ${property}`);
  };
  const restore = () => {
    calls.push("restore-package"); const back = restorePackagePreimage(npmRoot, prefix, preimage);
    return { ok: back.ok, message: back.ok ? "Previous package restored" : `Package restore failed: ${back.reason}` };
  };
  const verified: VerifiedTarget = { bin: entry, entry, node: newNode, dir: pkg };
  const deps = {
    run, readFile: (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    writeFile: (path: string, content: string) => { calls.push("write-unit"); writeFileSync(path, content); },
    realpath: (path: string) => { try { return realpathSync(path); } catch { return null; } },
    readFirstLine: (path: string) => { try { return readFileSync(path, "utf8").split("\n")[0] ?? null; } catch { return null; } },
    isExecutable: (path: string) => { try { const s = statSync(path); return s.isFile() && !!(s.mode & 0o111); } catch { return false; } },
    refresh: () => { calls.push("refresh"); writeFileSync(unitPath, newUnit); return result(); },
    restart: () => {
      calls.push("restart");
      if (restart === "failed") Object.assign(state, { active: "failed", sub: "failed", pid: 0, control: 0, job: 0 });
      if (restart === "pending") Object.assign(state, { active: "activating", sub: "start", pid: 333, control: 0, job: 1 });
      return restart;
    },
    log: () => {}, restorePackage: () => restore().message, systemdRecovery: { restorePackage: restore },
  } satisfies ActivationDeps & { systemdRecovery: { restorePackage: typeof restore } };
  return { root, prefix, npmRoot, pkg, entry, oldNode, newNode, oldUnit, newUnit, unitPath, olderBackup, preimage,
    state, calls, verified, deps, run, result, restore,
    version: () => JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string,
    setRestart: (value: typeof restart) => { restart = value; }, setHook: (value: typeof hook) => { hook = value; },
    setLoadedArgv: (value: string[]) => { loadedArgv = value; },
    setManagerEnv: (value: string[]) => { managerEnv = value; },
    setStopStatus: (status: number) => { stopStatus = status; }, setStartStatus: (status: number) => { startStatus = status; }, setReloadStatus: (status: number) => { reloadStatus = status; },
  };
}

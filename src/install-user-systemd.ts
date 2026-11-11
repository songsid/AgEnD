/** #3630: install diagnostics only; never restart the user manager. */
import { readFileSync } from "node:fs";
import { privateSocketPath } from "./systemd-peer-bus.js";
import { t } from "./locale.js";

export interface InstallUserManagerProblem {
  kind: "stopped" | "missing-sockets" | "unavailable";
  uid: number;
  unit: string;
  bus: string;
  privateSocket: string;
}

export interface InstallUserManagerDeps {
  uid: number;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  state(unit: string, user: boolean): "running" | "stopped" | "unavailable";
}

export function inspectInstallUserManager(unit: string, d: InstallUserManagerDeps): InstallUserManagerProblem | null {
  // The existing state reader distinguishes an inactive/missing unit from a connection failure.
  if (d.state(unit, true) !== "unavailable") return null;
  const privateSocket = privateSocketPath(true, d.env, d.uid);
  const bus = (d.env.XDG_RUNTIME_DIR || `/run/user/${d.uid}`) + "/bus";
  const manager = d.state(`user@${d.uid}.service`, false);
  // A stale shell runtime directory cannot establish loss of this manager's sockets.
  const managerPaths = privateSocket === privateSocketPath(true, {}, d.uid);
  const kind = manager === "stopped" ? "stopped"
    : manager === "running" && managerPaths && !d.exists(bus) && !d.exists(privateSocket) ? "missing-sockets" : "unavailable";
  return { kind, uid: d.uid, unit, bus, privateSocket };
}

export class InstallUserManagerError extends Error {
  constructor(readonly problem: InstallUserManagerProblem) {
    super(t(`install.user_manager_${problem.kind}`, `user@${problem.uid}.service`, problem.bus, problem.privateSocket));
    this.name = "InstallUserManagerError";
  }
}

export function installRunsOnWsl(env = process.env, version = () => readFileSync("/proc/version", "utf8")): boolean {
  if (env.WSL_DISTRO_NAME?.trim()) return true;
  try { return /microsoft|wsl/i.test(version()); } catch { return false; }
}

export function installActivationHints(error: unknown, platform: "linux" | "macos", path: string, wsl = installRunsOnWsl()): string[] {
  if (!(error instanceof InstallUserManagerError)) {
    return [t("install.run_manually", platform === "macos" ? `launchctl load ${path}`
      : "systemctl --user daemon-reload && systemctl --user enable --now com.agend.fleet")];
  }
  const p = error.problem;
  const manager = `user@${p.uid}.service`;
  const prefix = p.uid === 0 ? "" : "sudo ";
  if (p.kind === "unavailable") {
    return [...(wsl ? [t("install.user_manager_wsl")] : []), t("install.user_manager_check"), `${prefix}systemctl status ${manager}`];
  }
  return [
    ...(p.kind === "missing-sockets" ? [t("install.user_manager_env"), t("install.user_manager_interrupt", manager)] : []),
    ...(wsl ? [t("install.user_manager_wsl") + " " + t("install.user_manager_wsl_recover")] : []),
    t("install.user_manager_manual"), `${prefix}systemctl ${p.kind === "stopped" ? "start" : "restart"} ${manager}`,
    `export XDG_RUNTIME_DIR=/run/user/${p.uid}`, "unset DBUS_SESSION_BUS_ADDRESS",
    "systemctl --user start dbus.socket", "systemctl --user daemon-reload", `systemctl --user enable --now --no-block ${p.unit}`,
  ];
}

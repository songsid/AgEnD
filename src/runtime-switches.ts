/**
 * M-2255 (the user, hmsg-71c25c9b): the Windows runtimes are switched on in Settings → Runtime, saved in fleet.yaml
 * (`runtimes.windows_cli`, `runtimes.remote_runtime`, both off by default), instead of only by environment variables.
 *  - windows_cli: agents may run the Windows CLIs installed on this PC (through WSL), as AGEND_WINDOWS_CLI=1 did;
 *  - remote_runtime: other Windows computers may pair with this fleet and run its agents, as AGEND_REMOTE_RUNTIME=1 did.
 * The environment variables stay an override: "1" turns a switch on and "0" off whatever fleet.yaml says (Settings then
 * says "set by the environment" and cannot change it); unset (or any other value) leaves it to fleet.yaml.
 *
 * Every gate reads the APPLIED state here (runtimeSwitchOn), which the fleet sets each time it loads or saves its
 * configuration (setConfiguredRuntimeSwitches), so what fleet.yaml says and what the fleet does never drift apart. The
 * environment is read on every call, as before.
 */
export const RUNTIME_SWITCHES = ["windows_cli", "remote_runtime"] as const;
export type RuntimeSwitchName = typeof RUNTIME_SWITCHES[number];
export const RUNTIME_SWITCH_ENV: Readonly<Record<RuntimeSwitchName, string>> = { windows_cli: "AGEND_WINDOWS_CLI", remote_runtime: "AGEND_REMOTE_RUNTIME" };
export interface RuntimesConfig { windows_cli?: boolean; remote_runtime?: boolean; max_agents_per_machine?: number }
/**
 * #2953 1.8: how many Windows agents may run at once on each Windows computer — this PC and each paired one. A whole
 * number in these bounds; absent (or out of them, refused by the validator) is the default.
 */
export const MAX_AGENTS_PER_MACHINE = { min: 1, max: 16, default: 4 } as const;
const validLimit = (value: unknown): value is number => Number.isInteger(value)
  && (value as number) >= MAX_AGENTS_PER_MACHINE.min && (value as number) <= MAX_AGENTS_PER_MACHINE.max;
export interface RuntimeSwitchState {
  /** In force now. */
  on: boolean;
  /** What fleet.yaml says (absent: off). */
  configured: boolean;
  /** The environment's override, if any: Settings shows it and cannot change the switch while it is set. */
  environment: "on" | "off" | null;
}

let configured: Record<RuntimeSwitchName, boolean> = { windows_cli: false, remote_runtime: false };
let configuredLimit: number = MAX_AGENTS_PER_MACHINE.default;

/** The environment's override for a switch: "1" on, "0" off, anything else (or unset) none. */
export function runtimeSwitchEnvironment(name: RuntimeSwitchName): "on" | "off" | null {
  const value = process.env[RUNTIME_SWITCH_ENV[name]];
  return value === "1" ? "on" : value === "0" ? "off" : null;
}
/** Only `true` turns a switch on: a value of another kind (refused by the validator) counts as off. */
export function configuredRuntimeSwitches(runtimes: unknown): Record<RuntimeSwitchName, boolean> {
  const value = runtimes && typeof runtimes === "object" && !Array.isArray(runtimes) ? runtimes as Record<string, unknown> : {};
  return { windows_cli: value.windows_cli === true, remote_runtime: value.remote_runtime === true };
}
/** Set by the fleet from its configuration in force (fleet.yaml's `runtimes`). */
export function setConfiguredRuntimeSwitches(runtimes: unknown): void {
  configured = configuredRuntimeSwitches(runtimes);
  configuredLimit = configuredMaxAgentsPerMachine(runtimes);
}
export function configuredMaxAgentsPerMachine(runtimes: unknown): number {
  const value = runtimes && typeof runtimes === "object" && !Array.isArray(runtimes) ? (runtimes as Record<string, unknown>).max_agents_per_machine : undefined;
  return validLimit(value) ? value : MAX_AGENTS_PER_MACHINE.default;
}
/** #2953 1.8: the per-computer limit in force (Settings → Runtime; default 4). The Windows adapter reads it per start. */
export function maxAgentsPerMachine(): number { return configuredLimit; }
export function runtimeSwitchState(name: RuntimeSwitchName, runtimes?: unknown): RuntimeSwitchState {
  const saved = runtimes === undefined ? configured[name] : configuredRuntimeSwitches(runtimes)[name];
  const environment = runtimeSwitchEnvironment(name);
  return { on: environment ? environment === "on" : saved, configured: saved, environment };
}
export function runtimeSwitchOn(name: RuntimeSwitchName): boolean { return runtimeSwitchState(name).on; }
/** Agents may run this PC's Windows CLIs (through WSL). */
export function localWindowsCliEnabled(): boolean { return runtimeSwitchOn("windows_cli"); }
/** Other Windows computers may pair with this fleet and run its agents. */
export function remoteRuntimeEnabled(): boolean { return runtimeSwitchOn("remote_runtime"); }

/**
 * M-2255: PUT /api/settings/fleet/runtimes — `{ windows_cli?, remote_runtime?: boolean, max_agents_per_machine?: 1..16 }`, read the same way by
 * the confirmation gate and the handler. A switch the environment sets cannot be changed here (Settings says so).
 */
export function parseRuntimesSettingsBody(body: unknown): { patch: RuntimesConfig } | { error: string; status: 400 | 409 } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_runtimes_settings", status: 400 };
  const patch: RuntimesConfig = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "max_agents_per_machine") {
      if (!validLimit(value)) return { error: "invalid_runtimes_settings", status: 400 };
      patch.max_agents_per_machine = value;
      continue;
    }
    if (!(RUNTIME_SWITCHES as readonly string[]).includes(key) || typeof value !== "boolean") return { error: "invalid_runtimes_settings", status: 400 };
    if (runtimeSwitchEnvironment(key as RuntimeSwitchName)) return { error: "runtime_switch_set_by_environment", status: 409 };
    patch[key as RuntimeSwitchName] = value;
  }
  return { patch };
}

/**
 * What Settings → Runtime reads (GET /api/settings/runtimes, and a save's answer): each switch as fleet.yaml says it and
 * as in force, the per-computer limit, and this fleet's local address for the connection guide.
 */
export function runtimeSettingsView(cfg: { runtimes?: unknown; health_port?: number } | null | undefined): {
  switches: Record<RuntimeSwitchName, RuntimeSwitchState>;
  max_agents_per_machine: { value: number; min: number; max: number; default: number };
  local_origin: string;
} {
  const runtimes = cfg?.runtimes ?? {};
  return {
    switches: Object.fromEntries(RUNTIME_SWITCHES.map(name => [name, runtimeSwitchState(name, runtimes)])) as Record<RuntimeSwitchName, RuntimeSwitchState>,
    max_agents_per_machine: { value: configuredMaxAgentsPerMachine(runtimes), min: MAX_AGENTS_PER_MACHINE.min, max: MAX_AGENTS_PER_MACHINE.max, default: MAX_AGENTS_PER_MACHINE.default },
    local_origin: `http://127.0.0.1:${Number.isInteger(cfg?.health_port) ? cfg!.health_port : 19280}`,
  };
}

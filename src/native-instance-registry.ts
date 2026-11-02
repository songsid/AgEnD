/** Runtime identity shared by Fleet, HTTP and the native Windows execution adapter. */
import type { FleetConfig, InstanceConfig } from "./types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { validWindowsAgentId } from "./windows-cli-worker.js";
import { isNativeProviderId } from "./windows-cli-providers.js";
import type { WindowsAgent, WindowsAgents, WindowsAgentPatch } from "./windows-agents.js";

/** M-2239 P1-1: why create_instance (and every path through handleCreate) refuses a Windows agent. */
export const WINDOWS_CREATE_REFUSED = "Windows agents can only be created by an administrator in the web dashboard (Fleet → New agent → Native Windows), not through create_instance or a template";
/** M-2239 P1-1: why another agent's MCP call may not reconfigure or replace a Windows agent. */
export const WINDOWS_CONFIG_REFUSED = "A Windows agent's settings are changed by an administrator in the web dashboard, not through MCP";

export type NativeInstanceConfig = InstanceConfig & { runtime:"windows"; native_agent_id:string; native_sandbox:"read-only"|"workspace-write" };
export function nativeInstanceName(agentId: string): string {
  if (!validWindowsAgentId(agentId)) throw new Error("Invalid Windows agent id");
  return `windows-${agentId.toLowerCase()}`;
}
export function isWindowsInstance(config: Partial<InstanceConfig> | null | undefined): config is InstanceConfig & {runtime:"windows"} {
  return config?.runtime === "windows";
}
export function nativeAgentId(config: Partial<InstanceConfig> | null | undefined): string | null {
  return isWindowsInstance(config) && validWindowsAgentId(config.native_agent_id) ? config.native_agent_id.toLowerCase() : null;
}
export function nativeInstanceConfig(agent: Omit<WindowsAgent,"turns"|"instructions"> & {instructions?:string}): NativeInstanceConfig {
  return {
    ...structuredClone(DEFAULT_INSTANCE_CONFIG), runtime:"windows",native_agent_id:agent.id,native_sandbox:agent.sandbox,
    working_directory:agent.cwd,display_name:agent.name,description:agent.description,backend:agent.cli,
    // Explicit empties prevent a Linux fleet's model/prompt from being inherited on config reload.
    model:agent.model || "",systemPrompt:agent.instructions || "",agent_mode:"cli",
  };
}

/** Import legacy native profiles once. Existing Fleet entries remain the source of settings. */
export function registerWindowsProfiles(fleet: FleetConfig, store: WindowsAgents, save: () => void): boolean {
  const before = { ...fleet.instances };
  let changed = false, saved = false;
  const bindings:Array<{id:string;name:string}>=[];
  try {
    const claimed = new Set(Object.values(fleet.instances).map(nativeAgentId).filter((id): id is string => id !== null));
    for (const profile of store.list()) {
      if (claimed.has(profile.id.toLowerCase())) {
        const entry=Object.entries(fleet.instances).find(([,config])=>nativeAgentId(config)===profile.id.toLowerCase());
        if(entry)bindings.push({id:profile.id,name:entry[0]});
        continue;
      }
      if(profile.fleet_instance)continue;
      const name = nativeInstanceName(profile.id);
      if (Object.hasOwn(fleet.instances,name)) throw new Error(`Cannot register Windows agent over existing instance ${name}`);
      fleet.instances[name] = nativeInstanceConfig(store.get(profile.id));
      claimed.add(profile.id.toLowerCase());changed = true;
      bindings.push({id:profile.id,name});
    }
    if (changed) { save(); saved = true; }
    for(const binding of bindings)store.bindInstance(binding.id,binding.name);
    return changed;
  } catch(error) { if(!saved)fleet.instances = before; throw error; }
}

/** Copy common instance settings into provider state before use, keeping session/history untouched. */
export function syncWindowsProfile(config: InstanceConfig, store: WindowsAgents, authorized: () => boolean = () => true): WindowsAgent {
  const id = nativeAgentId(config);
  if (!id) throw new Error("Instance does not name a Windows runtime agent");
  const current = store.get(id);
  const patch: WindowsAgentPatch = {};
  const desired: WindowsAgentPatch = {
    name:config.display_name ?? current.name,cwd:config.working_directory,
    description:config.description ?? "",instructions:config.systemPrompt ?? "",
    model:config.model ?? "",sandbox:config.native_sandbox ?? current.sandbox,
  };
  if (config.backend !== undefined) {
    if (!isNativeProviderId(config.backend)) throw new Error("Choose a supported Windows CLI");
    desired.cli = config.backend;
  }
  for (const key of Object.keys(desired) as Array<keyof WindowsAgentPatch>) {
    if ((desired[key] ?? "") !== (current[key] ?? "")) (patch as Record<string,unknown>)[key] = desired[key];
  }
  return Object.keys(patch).length ? store.update(id,patch,authorized) : current;
}

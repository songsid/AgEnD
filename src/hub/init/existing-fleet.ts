/**
 * Is there already a personal fleet in this OS account? (hub.md §1 "Web entry and same-machine trust"; #3095 addendum
 * "Hub and a personal fleet on one machine".) A Hub in the same account shares the UID with that fleet's full-tool
 * agents, so the wizard warns, recommends a dedicated account and needs an explicit confirmation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { isSetupComplete } from "../../setup-marker.js";

export interface FleetProbe {
  /** True when the pid in fleet.pid is a live process. */
  pidAlive(pid: number): boolean;
}

export function existingFleetEvidence(home: string, probe: FleetProbe): string[] {
  const evidence: string[] = [];
  const fleetYaml = join(home, "fleet.yaml");
  if (existsSync(fleetYaml)) {
    let cfg: Record<string, unknown> | undefined;
    try {
      const loaded = yaml.load(readFileSync(fleetYaml, "utf8"));
      cfg = loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : undefined;
    } catch {
      evidence.push("fleet.yaml (unreadable)");
    }
    if (cfg) {
      const instances = cfg.instances && typeof cfg.instances === "object" ? Object.keys(cfg.instances as object).length : 0;
      if (instances > 0) evidence.push(`fleet.yaml with ${instances} agent(s)`);
      const channels = Array.isArray(cfg.channels) ? cfg.channels.length : 0;
      if (cfg.channel || channels > 0) evidence.push("fleet.yaml with a chat channel");
    }
  }
  try {
    if (isSetupComplete(home)) evidence.push("a completed fleet setup");
  } catch {
    /* unreadable marker: other evidence decides */
  }
  const pidFile = join(home, "fleet.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && probe.pidAlive(pid)) evidence.push(`a running fleet (pid ${pid})`);
  }
  return evidence;
}

// An installed AgEnD service alone is not evidence: a dedicated Hub account runs the same service with no agents.
export const realFleetProbe = (): FleetProbe => ({
  pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
});

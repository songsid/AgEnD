/** Local-owner display only: no lifecycle commands, networking, secret reads or deletion. */
import { join } from "node:path";
import { getAgendHome } from "../../paths.js";
import { ht } from "./text.js";
import { HUB_INVENTORY_REL, HUB_INVENTORY_PATHS, readHubInstallationInventory, type HubInstallationInventory } from "./inventory.js";

export interface HubHandoffService { installed: boolean; path?: string | null; manager?: string | null }
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function hubHandoffLines(home: string, inventory: HubInstallationInventory, service?: HubHandoffService): string[] {
  if (/[\u0000-\u001f\u007f]/.test(home)) throw Error("invalid_hub_handoff_home");
  const command = (args: string) => `AGEND_HOME=${quote(home)} agend ${args}`;
  return [ht("handoff_title", inventory.recordedAt), ht("handoff_snapshot"),
    ht("handoff_record", join(home, HUB_INVENTORY_REL)),
    ...HUB_INVENTORY_PATHS.map((path, i) => ht((['handoff_config', 'handoff_data', 'handoff_log'] as const)[i]!, join(home, path))),
    ...(service?.installed && service.path ? [ht("handoff_service", JSON.stringify(service.path), service.manager ?? "AgEnD")] : []),
    ht("handoff_scope"), ht("handoff_stop", command("stop")), ht("handoff_restart", command("restart")),
    ht("handoff_uninstall", command("uninstall")), ht("handoff_preserve"),
    ht("handoff_repeat", command("hub handoff")), ht("pairing_title"),
    ht("pairing_steps", inventory.webOrigin, inventory.memberOrigin, inventory.spkiSha256)];
}

export async function runHubHandoffCommand(): Promise<void> {
  try {
    const home = getAgendHome(), inventory = readHubInstallationInventory(home);
    let service: HubHandoffService | undefined;
    try { const { inspectService } = await import("../../service-installer.js"); service = inspectService("com.agend.fleet"); }
    catch { /* Optional service observation must not hide the recorded handoff. */ }
    console.log(hubHandoffLines(home, inventory, service).join("\n"));
  } catch {
    console.error(ht("handoff_unavailable")); process.exitCode = 1;
  }
}

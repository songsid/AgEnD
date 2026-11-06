/**
 * #2275: what is left of the Canvas Worker opt-in. #2793 turned the effects off for good; #2799 removed their code.
 * A saved `web.experimental.canvas_worker` still loads and stays in the file (a downgrade finds it) and turns nothing
 * on. An agent whose session still lists a removed tool, or a page or CLI that still asks for one, is told plainly.
 */
import { isAbsolute, join, resolve } from "node:path";

export const CANVAS_WORKER_EXPERIMENTAL_MESSAGE = "Canvas Worker effects were removed; ambient effects are still available";

/** The removed Canvas Worker tools: a call to one is answered with the message above (a resumed session may hold them). */
const CANVAS_WORKER_TOOLS: ReadonlySet<string> = new Set([
  "upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect",
  "apply_web_effect", "remove_web_effect", "delete_web_effect", "export_web_mod", "propose_web_mod",
]);
export function isCanvasWorkerTool(name: string): boolean { return CANVAS_WORKER_TOOLS.has(name); }

/** Only a config reference explicitly scoped to this home may cross a process boundary. */
export function scopedFleetConfigEnvironment(dataDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const owner = env.AGEND_FLEET_DATA_DIR, config = env.AGEND_FLEET_CONFIG_PATH;
  if (!owner || !config || !isAbsolute(owner) || !isAbsolute(config) || resolve(owner) !== resolve(dataDir)) return {};
  return { AGEND_FLEET_DATA_DIR: resolve(owner), AGEND_FLEET_CONFIG_PATH: resolve(config) };
}
/** The fleet.yaml a child process of this home reads (the scoped reference, else <home>/fleet.yaml). */
export function fleetConfigPath(dataDir: string): string {
  return scopedFleetConfigEnvironment(dataDir).AGEND_FLEET_CONFIG_PATH ?? join(dataDir, "fleet.yaml");
}

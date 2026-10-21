/** #2275: the one opt-in rule shared by agent menus, calls and the web. */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
import type { WebConfig } from "./types.js";

export const CANVAS_WORKER_EXPERIMENTAL_MESSAGE = "Canvas Worker effects are an experimental feature; enable it in Settings → Web appearance";
export function canvasWorkerEnabled(web?: Pick<WebConfig, "experimental"> | null): boolean {
  return web?.experimental?.canvas_worker === true;
}

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
export function canvasWorkerConfigPath(dataDir: string): string {
  return scopedFleetConfigEnvironment(dataDir).AGEND_FLEET_CONFIG_PATH ?? join(dataDir, "fleet.yaml");
}

/** Child MCP servers and managed skill readers use their owning data dir, never cwd. Missing/invalid is off. */
export function readCanvasWorkerEnabled(dataDir: string): boolean {
  try {
    const raw = readFileSync(canvasWorkerConfigPath(dataDir), "utf8");
    const parsed = yaml.load(raw) as { web?: Pick<WebConfig, "experimental"> } | null;
    return canvasWorkerEnabled(parsed?.web);
  } catch { return false; }
}

/** Polling survives atomic config replacement, unlike watching the old file inode. */
export function watchCanvasWorkerEnabled(dataDir: string, changed: (enabled: boolean) => void, interval = 1000): () => void {
  let previous = readCanvasWorkerEnabled(dataDir);
  const check = () => {
    const current = readCanvasWorkerEnabled(dataDir);
    if (current === previous) return;
    previous = current;
    changed(current);
  };
  const timer = setInterval(check, interval);
  timer.unref();
  return () => clearInterval(timer);
}

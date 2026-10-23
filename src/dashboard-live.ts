/**
 * The dashboard switches as the fleet config says now, for an agent's MCP server (dashboard-permissions.ts): its tool
 * menu follows them without a restart, read from the same file and polled the same way as the Canvas Worker switch
 * (web-experimental.ts). Its own module so the agent CLI's private module tree (web-experimental's importers) stays as it is.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { canvasWorkerConfigPath } from "./web-experimental.js";
import { dashboardFeaturesOffIn, type DashboardFeature } from "./dashboard-permissions.js";

/**
 * The dashboard features switched off for `instance` in the fleet config as it is on disk now (dashboard-permissions.ts):
 * the MCP server's menu follows it without a restart. Unreadable: `fallback` (what the daemon wrote at spawn).
 */
export function readDashboardOff(dataDir: string, instance: string, fallback: DashboardFeature[]): DashboardFeature[] {
  try {
    return dashboardFeaturesOffIn(yaml.load(readFileSync(canvasWorkerConfigPath(dataDir), "utf8")), instance);
  } catch { return fallback; }
}
/** Polls like watchCanvasWorkerEnabled; `changed` gets the new list when it differs. */
export function watchDashboardOff(dataDir: string, instance: string, fallback: DashboardFeature[], changed: (off: DashboardFeature[]) => void, interval = 1000): () => void {
  let previous = readDashboardOff(dataDir, instance, fallback).join(",");
  const timer = setInterval(() => {
    const current = readDashboardOff(dataDir, instance, fallback);
    if (current.join(",") === previous) return;
    previous = current.join(",");
    changed(current);
  }, interval);
  timer.unref();
  return () => clearInterval(timer);
}

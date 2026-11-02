/**
 * #1519 P7 (docs/design/ux-onboarding-walkthrough.md §5.1): the CLI points to the web. `agend quickstart`, `agend
 * setup` and `agend init` end with where the dashboard is and how to sign in to it — the same words from each.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { isWebOnlyFleetConfig } from "./web-only-fleet.js";

export const DEFAULT_HEALTH_PORT = 19280;

/** The dashboard's port for the fleet configured at `configPath`: its `health_port`, else the default. Never throws. */
export function dashboardPort(configPath: string): number {
  try {
    const parsed = yaml.load(readFileSync(configPath, "utf-8")) as { health_port?: unknown } | null;
    const port = parsed?.health_port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HEALTH_PORT;
  } catch {
    return DEFAULT_HEALTH_PORT;
  }
}

/**
 * #2910 D5: the fleet configured at `configPath` has no Discord or Telegram connection (a web-only fleet). A file that
 * cannot be read or parsed is not one (the wording that names both ways in stays). Never throws.
 */
export function webOnlyConfigFile(configPath: string): boolean {
  try { return isWebOnlyFleetConfig(yaml.load(readFileSync(configPath, "utf-8")) as never); } catch { return false; }
}

/**
 * The lines that say where the dashboard is and how to sign in (no colour: the caller styles them). A web-only fleet has
 * no bot to send /web to (#2910 D5): only the way in that exists.
 */
export function dashboardLines(port: number, opts: { webOnly?: boolean } = {}): [string, string] {
  return [
    `Web dashboard: http://localhost:${port}/`,
    opts.webOnly ? "Sign in with `agend web --code` on this machine." : "Sign in with `agend web --code` on this machine, or send /web to your bot.",
  ];
}

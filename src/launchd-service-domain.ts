/** A Hub's SSH/background service keeps the same identity and uses launchd's user domain. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { sessionType } = createRequire(import.meta.url)("../launcher/launchd-session-type.cjs") as { sessionType(definition: string | null): "Background" | undefined };

export function launchdSessionType(definition: string | null): "Background" | undefined {
  return sessionType(definition);
}

export function launchdServiceDomain(label = "com.agend.fleet", options: { home?: string; uid?: number } = {}): string {
  let definition: string | null = null;
  try { definition = readFileSync(join(options.home ?? homedir(), "Library", "LaunchAgents", `${label}.plist`), "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot read the service definition; no launchd domain was selected"); }
  return `${launchdSessionType(definition) ? "user" : "gui"}/${options.uid ?? process.getuid?.() ?? 501}`;
}

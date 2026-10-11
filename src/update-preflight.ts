/**
 * #1441 part B: before `agend update` touches anything (the update marker, nvm, npm), decide whether the release it is
 * about to install can run on this host — on the Node it will actually run on. That is the target's bundled runtime
 * where the target pins one for this host and the host can run it (#1450: then the system Node does not matter), and
 * otherwise the system Node (the `node` on PATH, or nvm's Node 22 on the sudo path). The answers come from the same
 * helpers the preinstall guard, the postinstall and the launcher use (launcher/runtime-platform.cjs).
 *
 * Design baseline: #1441 issuecomment-6108441160. An unreadable answer is never "compatible" and never invented into a
 * refusal: the update goes on and the target's own preinstall guard still refuses inside npm (the old package stays).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export interface RuntimeHost { platform: string; arch: string; id: string; glibc: string | null; darwinRelease: string | null }
export interface RuntimePlatform {
  hostPlatform(probe?: Partial<RuntimeHost>): RuntimeHost;
  runtimeSupport(host: RuntimeHost): { supported: boolean; reason: string | null };
  satisfiesEngines(version: string, range: string): boolean;
}

const require = createRequire(import.meta.url);
/** The one answer to "can this host run AgEnD's bundled Node?", shared with preinstall, postinstall and the launcher. */
export const runtimePlatform = require("../launcher/runtime-platform.cjs") as RuntimePlatform;

/** What the release about to be installed asks for: its Node range, and the runtime it pins per host id. */
export interface TargetManifest { version: string; engines: string | null; runtimePins: Record<string, string> }

/** The target's own requirements, from the registry npm installs from; null when they cannot be read. */
export function lookupTargetManifest(version: string, run: typeof execFileSync = execFileSync): TargetManifest | null {
  let raw: string;
  try {
    raw = String(run("npm", ["view", `@songsid/agend@${version}`, "version", "engines", "optionalDependencies", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000,
    }));
  } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as { version?: unknown; engines?: unknown; optionalDependencies?: unknown };
  if (typeof m.version !== "string") return null;
  const engines = m.engines && typeof m.engines === "object" && typeof (m.engines as { node?: unknown }).node === "string"
    ? (m.engines as { node: string }).node : null;
  const runtimePins: Record<string, string> = Object.create(null);
  if (m.optionalDependencies && typeof m.optionalDependencies === "object") {
    for (const [name, pin] of Object.entries(m.optionalDependencies as Record<string, unknown>)) {
      const id = /^@songsid\/agend-node-(.+)$/.exec(name)?.[1];
      if (id && typeof pin === "string") runtimePins[id] = pin;
    }
  }
  return { version: m.version, engines, runtimePins };
}

export type UpdateTargetVerdict =
  | { kind: "runtime"; host: string; pin: string }
  | { kind: "system"; node: string; via: "path" | "nvm" }
  | { kind: "refuse"; message: string; summary: string }
  | { kind: "unknown"; note: string };

/** The Node version nvm's `nvm install 22` lands on is the newest 22.x; judge it as a 22 at the top of the line. */
const NVM_NODE_22 = "22.999.0";

/**
 * Which Node the target will run on here, and whether that Node satisfies the target's engines. `systemNode` is the
 * version of the `node` on PATH (null if there is none or it cannot be read); `viaNvm` is the update's sudo path.
 */
export function evaluateUpdateTarget(input: {
  manifest: TargetManifest | null;
  host: RuntimeHost;
  platform?: RuntimePlatform;
  systemNode: string | null;
  systemNodePath?: string | null;
  viaNvm: boolean;
}): UpdateTargetVerdict {
  const p = input.platform ?? runtimePlatform;
  const m = input.manifest;
  if (!m || !m.engines) {
    return { kind: "unknown", note: "  Note: the release's Node requirements could not be read; its own install check still applies (a refusal there keeps this version installed)." };
  }
  const pin = Object.prototype.hasOwnProperty.call(m.runtimePins, input.host.id) ? m.runtimePins[input.host.id]! : null;
  const support = p.runtimeSupport(input.host);
  if (pin && support.supported) {
    if (p.satisfiesEngines(pin, m.engines)) return { kind: "runtime", host: input.host.id, pin };
    const summary = `v${m.version} pins Node ${pin} for ${input.host.id}, which is outside its own range ${m.engines}`;
    return { kind: "refuse", summary, message: refusal(m, `${summary}.`, null) };
  }
  const why = !pin ? `v${m.version} ships no bundled Node for ${input.host.id}` : `this host cannot use AgEnD's bundled Node: ${support.reason}`;
  const candidate = input.viaNvm ? NVM_NODE_22 : input.systemNode;
  if (candidate && p.satisfiesEngines(candidate, m.engines)) {
    return { kind: "system", node: input.viaNvm ? "22 (nvm)" : candidate, via: input.viaNvm ? "nvm" : "path" };
  }
  const onPath = input.viaNvm ? "nvm's Node 22" : input.systemNode ? `Node ${input.systemNode}${input.systemNodePath ? ` (${input.systemNodePath})` : ""}` : "no usable `node`";
  const summary = `v${m.version} needs Node ${m.engines}; ${why}, and the Node on PATH is ${onPath}`;
  return { kind: "refuse", summary, message: refusal(m, `${why}, and the Node on PATH is ${onPath}.`, m.engines) };
}

function refusal(m: TargetManifest, why: string, range: string | null): string {
  return [
    `  ✗ AgEnD v${m.version} cannot run on this host's Node — nothing was changed.`,
    "",
    `    v${m.version} needs Node ${m.engines}.`,
    `    ${why}`,
    "",
    range
      ? `    Install a Node in that range (for example: nvm install 22 && nvm use 22), then run: agend update`
      : "    This release cannot be installed here; wait for the next one.",
  ].join("\n");
}

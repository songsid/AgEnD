import { normalizeSettingsInstancePatch } from "./settings-instance-patch.js";
import { basename } from "node:path";
import { draftQuickstart, newConnectionConflict, planQuickstart, validateWizardInput, wizardChannels, type WizardPlanInput } from "./quickstart-api.js";
import type { FleetConfig } from "./types.js";
import { settingsChangeDiff, type SettingsChangeDiff } from "./settings-change.js";
import { SettingsConfirmationError } from "./settings-confirmation.js";
import { validateFleetConfig, validateClassicBotConfig } from "./config-validator.js";

export interface SettingsSecretProof {
  readonly key: string; readonly secret: string; readonly previous?: string;
  readonly remainingMs: number; readonly binding?: { group_id: string; general_channel_id?: string | null };
  discard(): void;
}
export interface SettingsEffectContext {
  config: FleetConfig | null; classic: Record<string, any>;
  proof?(kind: "provider" | "secret" | "binding", target: string, verification: string, binding?: string, key?: string): SettingsSecretProof | null;
}
export function isSettingsMutation(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  return /^\/api\/settings\/(?:fleet\/(?:defaults|channels|web|instances(?:\/[^/]+)?)|classic\/(?:defaults|channels\/[^/]+)|(?:provider-secrets|secrets)\/[^/]+\/apply|connections\/[^/]+\/(?:secret|binding)\/apply|quickstart\/commit)$/.test(path)
    || path === "/ui/config" || path === "/ui/instances" || /^\/ui\/instances\/[^/]+\/delete$/.test(path);
}
function record(body: unknown): Record<string, any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsConfirmationError(400, "invalid_settings_body");
  return body as Record<string, any>;
}
/** A pure projection. Original handler validation still runs against the admitted baseline. */
export function prepareSettingsEffect(method: string, path: string, body: unknown, context: SettingsEffectContext, binding?: string, key?: string): {
  diff: SettingsChangeDiff | null; proof?: SettingsSecretProof;
} {
  const cfg = context.config, before: any = { fleet: structuredClone(cfg), classic: structuredClone(context.classic) }, after = structuredClone(before);
  const operation = `${method} ${path}`;
  const secret = path.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/([^/]+)\/apply$/);
  const connection = path.match(/^\/api\/settings\/connections\/([^/]+)\/(secret|binding)\/apply$/);
  if (secret || connection) {
    const payload = record(body), kind = secret ? "provider" : connection![2] as "secret" | "binding", target = decodeURIComponent((secret ?? connection)![1]);
    const proof = context.proof?.(kind, target, String(payload.verification_id ?? ""), binding, key);
    if (!proof || !(proof.remainingMs > 0)) throw new SettingsConfirmationError(422, "verification_expired");
    if (kind === "binding") {
      const channels = cfg?.channels ?? (cfg?.channel ? [cfg.channel] : []), current = channels.find((item, i) => (item.id ?? item.type ?? `channel-${i}`) === target);
      if (!current || !proof.binding) throw new SettingsConfirmationError(422, "invalid_binding_proof");
      const candidate = { ...current, group_id: proof.binding.group_id, options: { ...current.options } };
      if (proof.binding.general_channel_id === null) delete candidate.options.general_channel_id;
      else if (proof.binding.general_channel_id !== undefined) candidate.options.general_channel_id = proof.binding.general_channel_id;
      return { diff: settingsChangeDiff({ channels: [current] }, { channels: [candidate] }, { operation, force: true }), proof };
    }
    const diff = settingsChangeDiff(null, null, { operation, secret: { key: proof.key, before: proof.previous, after: proof.secret }, force: true })!;
    return { diff: { ...diff, affectedConnections: connection ? [target] : [] }, proof };
  }
  let force = false;
  if (path === "/api/settings/fleet/channels") {
    if (!cfg || !Array.isArray(body)) throw new SettingsConfirmationError(400, "invalid_channels");
    after.fleet.channels = body.map((item: unknown) => {
      const ch = structuredClone(record(item));
      if (typeof ch.group_id === "number") { if (!Number.isSafeInteger(ch.group_id)) throw new SettingsConfirmationError(400, "invalid_channel_id"); ch.group_id = String(ch.group_id); }
      if (typeof ch.options?.general_channel_id === "number") { if (!Number.isSafeInteger(ch.options.general_channel_id)) throw new SettingsConfirmationError(400, "invalid_channel_id"); ch.options.general_channel_id = String(ch.options.general_channel_id); }
      return ch;
    }); delete after.fleet.channel;
    before.fleet.channels = cfg.channels ?? (cfg.channel ? [cfg.channel] : []); delete before.fleet.channel;
  } else if (path === "/api/settings/fleet/defaults") {
    if (!cfg) throw new SettingsConfirmationError(503, "fleet_unavailable");
    after.fleet.defaults = { ...cfg.defaults, ...record(body) };
    if (after.fleet.defaults.locale === null || after.fleet.defaults.locale === "") delete after.fleet.defaults.locale;
  } else if (path === "/api/settings/fleet/web") {
    if (!cfg) throw new SettingsConfirmationError(503, "fleet_unavailable");
    const patch = record(body); after.fleet.web = { ...cfg.web, ...patch };
    if (patch.public_link) after.fleet.web.public_link = { ...cfg.web?.public_link, ...patch.public_link };
  } else if (path === "/api/settings/classic/defaults") {
    after.classic.defaults = { ...(before.classic.defaults ?? {}), ...record(body) };
    for (const key of ["tool_progress", "reply_completion_guard"]) if (after.classic.defaults[key] === null) delete after.classic.defaults[key];
  } else if (path.startsWith("/api/settings/classic/channels/")) {
    const key = decodeURIComponent(path.split("/").at(-1)!); after.classic.channels ??= {};
    if (!Object.hasOwn(after.classic.channels, key) || !after.classic.channels[key] || typeof after.classic.channels[key] !== "object" || Array.isArray(after.classic.channels[key]))
      throw new SettingsConfirmationError(404, "classic_channel_not_found");
    after.classic.channels = { ...after.classic.channels, [key]: { ...after.classic.channels[key], ...record(body) } };
    for (const key2 of ["model", "auto_pause_after", "tool_progress", "reply_completion_guard"]) if (after.classic.channels[key][key2] === null) delete after.classic.channels[key][key2];
  } else if (path === "/ui/config") {
    if (!cfg) throw new SettingsConfirmationError(503, "fleet_unavailable");
    const patch = record(body);
    if (patch.channel && cfg.channel) {
      if (patch.channel.group_id != null) after.fleet.channel.group_id = patch.channel.group_id;
      if (patch.channel.access) after.fleet.channel.access = patch.channel.access;
    }
    if (patch.defaults) {
      if (patch.defaults.backend) after.fleet.defaults.backend = patch.defaults.backend;
      if (patch.defaults.model) after.fleet.defaults.model = patch.defaults.model;
    }
    if (patch.project_roots) after.fleet.project_roots = patch.project_roots;
  } else if (path === "/api/settings/quickstart/commit") {
    const patch = record(body); if (!cfg || typeof patch.token !== "string" || typeof patch.token_env !== "string") throw new SettingsConfirmationError(400, "invalid_quickstart");
    if (validateWizardInput(patch)) throw new SettingsConfirmationError(400, "invalid_quickstart");
    const channels = wizardChannels(cfg);
    // #1519 P1 (S1): a new connection only — one that would take another's id or token env is refused, not proposed.
    if (newConnectionConflict(patch as WizardPlanInput, { channels })) throw new SettingsConfirmationError(409, "connection_exists");
    const plan = planQuickstart(patch as WizardPlanInput, { channels, has_fleet: !!Object.keys(cfg.instances).length, backends: [] });
    const draft = draftQuickstart(cfg, patch as WizardPlanInput, plan);
    const normalizedBefore = structuredClone(cfg); normalizedBefore.channels = cfg.channels ?? (cfg.channel ? [cfg.channel] : []); delete normalizedBefore.channel;
    const what = patch.connection_only === true ? `connection ${plan.channel_id}` : `instance ${patch.instance_name}`;
    return { diff: settingsChangeDiff(normalizedBefore, draft, { operation: `${operation} ${what}`, force: true, secret: { key: patch.token_env, after: patch.token } }) };
  } else if (path === "/ui/instances") {
    const payload = record(body), channels = cfg?.channels ?? (cfg?.channel ? [cfg.channel] : []);
    const name = payload.topic_name ?? (typeof payload.directory === "string" ? basename(payload.directory) : null);
    if (typeof name !== "string" || !name) throw new SettingsConfirmationError(400, "invalid_instance_name");
    const draft = { topic_name: name, directory: payload.directory,
      channels: channels.slice(0, 1).map((item, index) => ({ id: item.id ?? item.type ?? `channel-${index}`, type: item.type, group_id: item.group_id })),
      ...Object.fromEntries(Object.entries(payload).filter(([key]) => !["topic_name", "directory"].includes(key))) };
    // Target allocation is deferred; the approved request and current owner binding stay pinned.
    return { diff: settingsChangeDiff({}, { new_instance: draft }, { operation, force: true }) };

  } else {
    if (!cfg) throw new SettingsConfirmationError(503, "fleet_unavailable");
    const payload = method === "DELETE" ? {} : record(body), pieces = path.split("/");
    const name = path === "/ui/instances" || path === "/api/settings/fleet/instances" ? typeof payload.name === "string" ? payload.name.trim() : payload.name : decodeURIComponent(path.startsWith("/ui/") ? pieces[3] : pieces.at(-1)!);
    if (typeof name !== "string" || !name) throw new SettingsConfirmationError(400, "invalid_instance_name");
    const exists = Object.hasOwn(cfg.instances, name);
    if (method === "DELETE" || path.endsWith("/delete")) { delete after.fleet.instances[name]; force = true; }
    else {
      const patch = { ...payload }; delete patch.name;
      if (path === "/ui/instances") {
        after.fleet.instances = { ...after.fleet.instances, [name]: { ...(exists ? cfg.instances[name] : {}), working_directory: payload.working_directory, backend: payload.backend ?? cfg.defaults?.backend, model: payload.model } };
      } else {
        after.fleet.instances = { ...after.fleet.instances, [name]: normalizeSettingsInstancePatch(exists ? cfg.instances[name] : {}, patch) };
      }
      force = !exists;
    }
  }
  if (after.fleet && !validateFleetConfig(after.fleet).valid && validateFleetConfig(before.fleet).valid) throw new SettingsConfirmationError(400, "invalid_settings_effect");
  if (!validateClassicBotConfig(after.classic).valid && validateClassicBotConfig(before.classic).valid) throw new SettingsConfirmationError(400, "invalid_classic_effect");
  return { diff: settingsChangeDiff(before, after, { operation, force }) };
}

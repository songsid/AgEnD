/**
 * #1269 (4): an instance's chat commands, run from the web chat. Only what the instance's own Discord/Telegram topic
 * already accepts, through the same handlers (topic-commands.ts / FleetManager) and the same table (command-table.ts,
 * #754/#1148): nothing here is a capability the platforms do not have.
 *
 * - Who: a signed-in web session holds the full-fleet credential, issued only to a fleet admin (/dashboard is
 *   fleet-admin only), so the table's admin levels are met — exactly as a web click on a mirrored prompt is answered
 *   "as a fleet admin on the platform". The table can still refuse a command in a kind of channel; that stands.
 * - What: instance commands only. Fleet-level ones (/status, /restart, /update, /login, …) stay in General
 *   (Discord-first), and /raw is not a command here (it bypasses the [user:] envelope).
 * - The public link (a gateway request) is the outward-facing surface: /save is refused there — it makes the CLI
 *   write a file under a name the caller picks, outside the agent's own judgement.
 * - /clear asks first, as on the platforms: the first call answers a confirmation token; only the second, with that
 *   token, clears — and only if the instance is still the one that was asked about.
 */
import { commandSpec, decideCommand, type CommandScope } from "./command-table.js";
import { SAVE_FILENAME_RE } from "./topic-commands.js";

export const WEB_COMMANDS = ["ctx", "compact", "clear", "model", "effort", "cancel", "btw", "steer", "pause", "wake", "save"] as const;
export type WebCommand = typeof WEB_COMMANDS[number];
/** Refused on the public link (see the header). */
export const PUBLIC_LINK_REFUSED: ReadonlySet<WebCommand> = new Set<WebCommand>(["save"]);
export const MAX_COMMAND_ARGS = 4000;

export interface WebChoices { current: string | null; options: Array<{ id: string; label: string }> }

export interface WebCommandDeps {
  /** The instance is one the web chat may command (a fleet instance or a ClassicBot room), and in which scope. */
  scope(instance: string): CommandScope | null;
  ctx(instance: string): Promise<string>;
  compact(instance: string, instructions: string | undefined): Promise<string>;
  applyModel(instance: string, name: string): Promise<string>;
  /** The model menu from the cached catalog only (never a live probe on this path); null: no list to offer. */
  modelChoices(instance: string): WebChoices | null;
  applyEffort(instance: string, level: string): Promise<string>;
  effortChoices(instance: string): WebChoices | null;
  cancel(instance: string): boolean;
  steer(instance: string, text: string): string;
  btw(instance: string, text: string): string;
  pauseWake(instance: string, action: "pause" | "wake"): Promise<string>;
  save(instance: string, filename: string): Promise<string>;
  /** Ask: a confirmation token (or why not). Confirm: clear, if the token is live and the instance unchanged. */
  clearAsk(instance: string): { token: string; message: string } | { refused: string };
  clearConfirm(instance: string, token: string): Promise<{ status: number; text: string }>;
  t(key: string, ...args: string[]): string;
}

export interface WebCommandInput { instance: string; command: string; args?: string; confirm?: string }
export interface WebCommandResult {
  status: number;
  body: { text?: string; error?: string; choices?: WebChoices; confirm?: { token: string; message: string } };
}

const isWebCommand = (c: string): c is WebCommand => (WEB_COMMANDS as readonly string[]).includes(c);

export async function runWebCommand(deps: WebCommandDeps, input: WebCommandInput, opts: { publicLink: boolean }): Promise<WebCommandResult> {
  const { instance } = input;
  const command = input.command.replace(/^\//, "");
  if (!isWebCommand(command)) return { status: 400, body: { error: deps.t("web.command_unknown", `/${command}`) } };
  if (opts.publicLink && PUBLIC_LINK_REFUSED.has(command)) return { status: 403, body: { error: deps.t("web.command_public_refused", `/${command}`) } };
  const scope = deps.scope(instance);
  if (!scope) return { status: 404, body: { error: deps.t("instance.not_found", instance) } };
  // The same table the platforms use; the session is fleet-admin level, so only a scope refusal can stand.
  const spec = commandSpec(command);
  if (!spec) return { status: 400, body: { error: deps.t("web.command_unknown", `/${command}`) } };
  const decision = decideCommand(spec, scope, { fleetAdmin: () => "ok", channelAdmin: () => true, classicAdmin: () => true });
  if (!decision.allow) return { status: 403, body: { error: deps.t(...decision.reply) } };
  const args = (input.args ?? "").trim();
  const ok = (text: string) => ({ status: 200, body: { text } });
  switch (command) {
    case "ctx": return ok(await deps.ctx(instance));
    case "compact": return ok(await deps.compact(instance, args || undefined));
    case "model": {
      if (args) return ok(await deps.applyModel(instance, args));
      const choices = deps.modelChoices(instance);
      return choices ? { status: 200, body: { choices } } : ok(deps.t("model.list_unavailable", instance));
    }
    case "effort": {
      if (args) return ok(await deps.applyEffort(instance, args));
      const choices = deps.effortChoices(instance);
      return choices ? { status: 200, body: { choices } } : { status: 400, body: { error: deps.t("web.command_no_choices", "/effort") } };
    }
    case "cancel": return ok(deps.cancel(instance) ? deps.t("cancel.sent", instance) : deps.t("cancel.not_running", instance));
    case "steer":
    case "btw":
      if (!args) return { status: 400, body: { error: deps.t(`${command}.usage`) } };
      return ok(command === "steer" ? deps.steer(instance, args) : deps.btw(instance, args));
    case "pause":
    case "wake": return ok(await deps.pauseWake(instance, command));
    case "save":
      if (!args) return { status: 400, body: { error: deps.t("save.usage") } };
      if (!SAVE_FILENAME_RE.test(args)) return { status: 400, body: { error: deps.t("filename.invalid") } };
      return ok(await deps.save(instance, args));
    case "clear": {
      if (input.confirm) { const r = await deps.clearConfirm(instance, input.confirm); return { status: r.status, body: r.status === 200 ? { text: r.text } : { error: r.text } }; }
      const asked = deps.clearAsk(instance);
      return "token" in asked ? { status: 200, body: { confirm: asked } } : { status: 409, body: { error: asked.refused } };
    }
  }
}

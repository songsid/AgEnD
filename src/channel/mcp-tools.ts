/**
 * MCP tool definitions. Schemas come from src/outbound-schemas.ts so runtime
 * validation and the JSON Schema surfaced to agents share one source.
 *
 * Kept free of runtime side effects — safe to import from tests and tools
 * without pulling in channel infrastructure.
 */
import { z, type ZodType } from "zod";
import { isCanvasWorkerTool } from "../web-experimental.js";
import * as schemas from "../outbound-schemas.js";

/** Narrow JSON-schema fragment shape that MCP tool listings need. */
type JsonSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
  [k: string]: unknown;
};

/** Strip client-incompatible keys and server-owned channel routing metadata. */
function toToolInputSchema(schema: ZodType): JsonSchemaObject {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _s, $defs: _d, ...rest } = raw;
  if (rest.type !== "object") {
    throw new Error("Expected object-typed zod schema for MCP tool input");
  }
  const { chat_id: _chat, thread_id: _thread, ...properties } = rest.properties as Record<string, unknown>;
  return { ...rest, properties } as JsonSchemaObject;
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
};

/**
 * Build the tool list. The `[schema, description]` pairs keep the declaration
 * terse and guarantee every tool has both a description and a schema.
 */
const DEFS: Array<[string, ZodType, string]> = [
  ["reply", schemas.ReplyArgs,
    "Reply on the channel. Routing is handled automatically — do not pass chat_id or thread_id. Add `buttons` to offer choices people can click."],
  ["react", schemas.ReactArgs,
    "Add an emoji reaction to a message — a Discord/Telegram message or a web chat message (its message_id starts with web-). A reaction is a complete answer to a message that only acknowledges or thanks (\"OK\", \"thanks\", \"收到\"), on every platform including the web chat; a task that needs a conclusion still needs reply. On the web chat use one emoji from the reaction set (e.g. 👍 👌 ❤ 🙏 🎉 🔥 💯) and never AgEnD's delivery marks; another emoji is refused with an error naming allowed ones."],
  ["edit_message", schemas.EditMessageArgs,
    "Edit a message the bot previously sent. Useful for interim progress updates."],
  ["download_attachment", schemas.DownloadAttachmentArgs,
    "Download a file attachment from a channel message. Returns the local file path ready to Read."],
  ["validate_config", schemas.ValidateConfigArgs,
    "Validate the fleet's config. Reads fleet.yaml + classicBot.yaml and returns { fleet, classic } validation results, each with errors[] and warnings[]."],
  ["create_schedule", schemas.CreateScheduleArgs,
    "Create a recurring cron schedule or a one-shot ISO datetime schedule. When triggered, sends a message to the target instance."],
  ["list_schedules", schemas.ListSchedulesArgs,
    "List all schedules. Optionally filter by target instance."],
  ["update_schedule", schemas.UpdateScheduleArgs,
    "Update an existing schedule. Only include fields you want to change."],
  ["delete_schedule", schemas.DeleteScheduleArgs,
    "Delete a schedule by ID."],
  ["task", schemas.TaskBoardArgs,
    "Manage fleet task board. Actions: create (new task), list (live tasks by default — compact rows; pass filter_status to include done/cancelled, verbose=true for full records; an unfiltered list returns the newest 100 with an omitted count, any filter lifts that cap), get (one full task by id/8-hex prefix), claim (assign to self), done (mark complete, works from open or claimed — a card that waits for confirmation goes to review instead: the person confirms the cards they handed out, the dispatcher an agent's card, finishing it from review with done), update (change status/priority/assignee). Ids accept an 8-hex prefix or a card number (M-3). Write actions return {id, status, updated_at} and the board's notes (a reason it was sent back, a comment you had not seen) when there are any. "
    + "Board cards — main tasks M-n (an outcome; the person confirms the ones they handed out) and their sub tasks S-n (your steps): mine (your work, including what was sent back and why: start here after a reset), get (the card as text, with its comments), projects, move (to a status; blocked/cancelled need a reason, finishing needs a result), create with project or parent, update with board fields (state, log, comment, check…). Answers are text. Open a main task for multi-step work you are asked for; split a big one into sub tasks (create with parent, depends_on for order). Keep state current (done / next / watch out). One card in progress at a time: finish it or block it (with the question) before the next; with many, follow mine's order. Finish: a sub task → done, a main task → review; sent back → read why (get), fix, resubmit. Opening a card for someone else makes you its dispatcher (or name one: dispatcher); a blocked card you handed out comes to you: ask the person, then move it back to claimed with the decision as the comment. A [Task board] notice is news on your cards: act on them with this tool."],
  ["post_decision", schemas.PostDecisionArgs,
    "Record a decision. scope='project' (default) is visible to instances sharing this working directory. scope='fleet' is visible to ALL instances regardless of directory — use for workflow rules, review policies, and team conventions."],
  ["close_poll", schemas.ClosePollArgs,
    "Close one of your open polls now, before its deadline (for example when everyone has answered). Its `[poll results]` come to you as when it times out, once."],
  ["list_decisions", schemas.ListDecisionsArgs,
    "List active decisions: this working directory's (scope='project') plus every fleet-scoped one, fleet first. Titles by default (id, title, scope, date, tags); pass id for one decision's full text, or full: true for all of it. Archived ones only with include_archived."],
  ["update_decision", schemas.UpdateDecisionArgs,
    "Update or archive an existing decision."],
  ["broadcast", schemas.BroadcastArgs,
    "Send a message to multiple instances at once. Priority: team > targets > tags > all running."],
  ["send_to_instance", schemas.SendToInstanceArgs,
    "Send a message to another instance. Use steer=true only for a mid-turn supplement to work you just sent. Returns {sent, queued, correlation_id} at once — acceptance, not delivery; a durable send also returns delivery_id and operation_id for delivery_status. forwards explicitly grants this receiver read-only delivery_status on up to 16 delivered rows you can read; each hop needs forwards, and an ID in the message text grants nothing."],
  ["request_information", schemas.RequestInformationArgs,
    "Ask another instance a question and expect a reply. Wrapper around send_to_instance with request_kind=query and requires_reply=true."],
  ["delegate_task", schemas.DelegateTaskArgs,
    "Delegate a task to another instance and expect a result report back. Supports steer=true for a mid-turn supplement. Optional forwards grants explicit read-only access to delivered references you can read; mentions grant nothing. Wrapper around send_to_instance with request_kind=task and requires_reply=true."],
  ["report_result", schemas.ReportResultArgs,
    "Report results back to an instance that delegated a task or asked a question. Wrapper around send_to_instance with request_kind=report."],
  ["delivery_status", schemas.DeliveryStatusArgs,
    "Read the status of a previously accepted delivery by delivery_id, operation_id, correlation_id, or message_id (human verification uses verification_id / agend-human-id, not the platform message_id). You can read your source/target rows and explicitly forwarded references; knowing an ID grants nothing. Not found also covers hidden/expired rows. Human receipts expose immutable original content, origin, original/wire hashes and owned proof_kind; native acceptance is not consumption. Uncertain means do not resend blindly."],
  ["create_team", schemas.CreateTeamArgs,
    "Create a named group of instances for targeted broadcasting. Teams persist across restarts."],
  ["delete_team", schemas.DeleteTeamArgs,
    "Dissolve a team. Does not affect the member instances."],
  ["list_teams", schemas.ListTeamsArgs,
    "List all teams with their members and running status."],
  ["update_team", schemas.UpdateTeamArgs,
    "Add or remove members from an existing team. Duplicates are ignored."],
  ["describe_instance", schemas.DescribeInstanceArgs,
    "Get detailed information about a specific instance: description, working directory, status, tags, and recent activity."],
  ["list_instances", schemas.ListInstancesArgs,
    "List the fleet's and ClassicBot instances (running, paused or stopped), excluding yourself. Filter by tags, name, backend or status. The name filter also matches display_name."],
  ["start_instance", schemas.StartInstanceArgs,
    "Start a stopped instance by name."],
  ["restart_instance", schemas.RestartInstanceArgs,
    "Restart a running instance. Reloads fleet config and restarts the instance."],
  ["pause_instance", schemas.PauseInstanceArgs,
    "Pause a running instance. Paused instances use no CPU/RAM and auto-wake on message."],
  ["wake_instance", schemas.WakeInstanceArgs,
    "Wake a paused instance immediately."],
  ["stop_instance", schemas.StopInstanceArgs,
    "Stop a running instance (terminates the daemon)."],
  ["get_fleet_status", schemas.GetFleetStatusArgs,
    "Get fleet summary: count of running, paused, and stopped instances — fleet instances and ClassicBot channels combined. Returns top-level totals (total, running, paused, stopped) plus a breakdown by kind: fleet (fleet.yaml instances) and classic (ClassicBot channels)."],
  ["get_effort", schemas.GetEffortArgs,
    "Get the reasoning-effort setting for an instance: the level in force, the levels its CLI backend accepts, and whether changing it takes effect immediately or needs a restart. Defaults to yourself."],
  ["kiro_engine_status", schemas.KiroEngineStatusArgs,
    "Show what each kiro instance runs on and whether the installed kiro-cli can still run it: its kiro_ui, the engine flags the next launch would use (or why kiro-cli refuses it), its recorded launches (kiro-cli and AgEnD versions per change), and its V3 session. Read-only. Use it to explain a kiro incompatibility or the kiro engine move to the user."],
  ["get_usage", schemas.GetUsageArgs,
    "Get AI subscription usage for the CLI backends logged in on this machine (Claude/Codex/Muse/Grok/Kiro/Antigravity). Returns per-provider metrics — use it to notice you are close to a limit and warn the user."],
  ["get_cache_report", schemas.GetCacheReportArgs,
    "Read the prompt-cache expiry report (the web dashboard's Fleet → cache), per instance: the TTL as written and the 5m/1h write mix, the effective TTL and gap-miss rate, requests, gaps past the TTL, expired-then-rewritten requests and tokens, expiry cost, the keep-warm simulation and its recommendation (including switch_to_1h: set backend_options.claude-code.prompt_cache_ttl: \"1h\"), whether figures are estimates or priced, and coverage (no_data, credit_billed, unsupported, shared). Read-only and from the last scan — it never reads transcripts itself; `scanning` says whether the scan has caught up. General, coordinators and full-profile instances read every row plus a fleet summary; any other instance reads only its own row."],
  ["get_usage_report", schemas.GetUsageReportArgs,
    "Read the usage report (the web dashboard's Fleet → Usage): per instance (or backend, model, credential profile, team), input / output / cache read / cache write tokens, requests, delivered messages, and each row's amount. Every amount is the API-equivalent at list price — NOT money spent (subscriptions are not billed per token): say \"API-equivalent\", never \"spent\" or \"cost\". Marks to repeat in words: cache_write_not_reported (Codex records no cache writes), not_priced (its tokens are shown, not its amount), profile_unknown (read before profiles were recorded); notMeasured lists instances whose backend AgEnD cannot measure, with the reason — never a $0 row. Days are in the fleet's timezone at hour granularity. Read-only and from the last scan. General, coordinators and full-profile instances read every row; any other instance reads only its own."],
  ["list_models", schemas.ListModelsArgs,
    "List the models a backend actually offers, before naming one in create_instance or update_instance_config. Pass instance_name to read the catalog through an existing instance's own config — an instance on a custom provider can offer a different set than the account. `scope` tells you which you got. An empty list is not a failure: model names are passed through to the CLI."],
  ["get_instance_logs", schemas.GetInstanceLogsArgs,
    "Read the last N lines of an instance's output log (default 50, max 200)."],
  ["get_fleet_config", schemas.GetFleetConfigArgs,
    "Read fleet configuration. scope='defaults' for fleet defaults, scope='instance' + name for a specific instance."],
  ["update_instance_config", schemas.UpdateInstanceConfigArgs,
    "Update a specific instance's config (backend, model, auto_pause_after, display_name, description, backend_options). Saves to fleet.yaml. backend_options merges per backend; null or \"\" drops a key; a change restarts the instance."],
  ["update_fleet_defaults", schemas.UpdateFleetDefaultsArgs,
    "Update fleet-wide defaults (backend, model, auto_pause_after, max_cross_instance_message_bytes). Saves to fleet.yaml."],
  ["create_instance", schemas.CreateInstanceArgs,
    "Create a new instance bound to a project directory with a channel topic. If directory is omitted, a workspace is auto-created at ~/.agend/workspaces/<instance-name>. Use backend_options.codex.provider (for example, 'glm') to select a Codex custom provider. tool_set and skipPermissions are refused here (set them in Settings or fleet.yaml). The fleet reconciles automatically after create — do not run `agend reload` afterwards (a redundant reload will restart every instance whose config changed, including ones you did not intend to touch)."],
  ["delete_instance", schemas.DeleteInstanceArgs,
    "Delete an instance: stop daemon, remove config, optionally delete topic. An instance may delete only itself; a General may delete any."],
  ["replace_instance", schemas.ReplaceInstanceArgs,
    "Replace an instance with a fresh one. Collects handover context from the old instance (or falls back to daemon ring buffer), deletes it, creates a new instance with the same config, and sends the handover context to the new instance."],
  ["set_display_name", schemas.SetDisplayNameArgs,
    "Set your display name. This name will be shown in Telegram messages, activity logs, and when other agents refer to you."],
  ["list_emojis", schemas.ListEmojisArgs,
    "List the emojis you can use as your persona emoji: your current status stamps, the standard emojis your platform accepts, and (Discord) the server emojis your bot can react with. Server emojis come without image URLs unless with_image_urls; filter them with name / limit / primary_only."],
  ["preview_emojis", schemas.PreviewEmojisArgs,
    "Download up to 8 Discord server emojis from list_emojis so you can see them: returns a local image path per emoji to Read before you pick one."],
  ["list_stickers", schemas.ListStickersArgs,
    "List the stickers you can send where you talk: { id, name, emoji_or_tags, format } each, no image URLs. Discord: your channel's server's stickers (another server's cannot be sent). Telegram: a sticker set, named by set (or the connection's default sets). Send with reply({ stickers: [id] })."],
  ["preview_stickers", schemas.PreviewStickersArgs,
    "Download up to 8 stickers from list_stickers so you can see them: returns a local image path per sticker to Read (an animated sticker with no still picture is listed as preview_unavailable)."],
  ["set_persona_emoji", schemas.SetPersonaEmojiArgs,
    "Set your persona emoji: the status stamp (default: delivered) your bot puts on messages it handles, so people can tell you apart from other bots. Other statuses: received, queued, processing, failed, progress_prefix, and photo / attachment (the stamp on a photo / file your bot saved). Validated the way Settings validates it; takes effect on your next stamp."],
  ["get_web_settings", schemas.GetWebSettingsArgs,
    "Settings → Look as it is now, for the user: every setting the page shows in plain words (summary) and as values — the host's (themes shown, identity colours, card sizes, sidebar widget), each agent's own colour, effects and ambient effect, one person's custom CSS and effect slots — the installed and proposed mods, the people whose own settings you may name, and what only the person can do on the page. General, coordinators and full profiles."],
  ["set_web_settings", schemas.SetWebSettingsArgs,
    "Change one Look setting for the user, exactly as the page changes it (the same checks; custom CSS keeps its safe rules): host settings, an agent's colour, an agent's card banner focus, custom CSS (save on trial, keep or revert the trial, use an earlier version, off), a proposed mod (review, install with the parts to apply, cancel, dismiss, uninstall), an effect on a chat, an agent's ambient effect (falling petals, click stars — set or clear), an effect slot, or Restore defaults. Returns { ok, ... } or { ok: false, error, detail }. See the web-appearance skill. General, coordinators and full profiles."],
  ["get_web_theme", schemas.GetWebThemeArgs,
    "Your own web theme (how your chat looks in the web dashboard): the current theme, the token defaults it is drawn over, your uploaded pictures, and your limits (changes left, each picture slot's size limits and your picture quota; uploads are not counted). No target: always yours."],
  ["set_web_theme", schemas.SetWebThemeArgs,
    "Change your own web theme, all or nothing: typed values only (colours #rrggbb, choices from fixed lists, numbers in range), contrast checked per light/dark mode. Returns { theme, rev } or { errors: [{ path, problem }] }. Rate-limited (30 s apart, 10 an hour); refused while a person has locked your theme."],
  ["set_web_theme_asset", schemas.SetWebThemeAssetArgs,
    "Upload a picture from your working directory for your theme's background or avatar, your identity card's portrait or banner, or a glyph for your ambient; returns { id } to name in set_web_theme (background.image, avatar, card.portrait, card.banner) or set_web_ambient (glyphs: [{ asset: id }]). Metadata (EXIF/GPS) is removed. Each slot's size limits and your picture quota apply."],
  ["get_web_appearance", schemas.GetWebAppearanceArgs,
    "How you appear on the web dashboard now: your face and where it comes from (profile, theme, bot, emoji or initial), your ring colour, your identity card field by field (a person's field wins over yours), your theme per light/dark mode after the defaults, whether a person locked it, your placed effects and closed recent playback-block reasons, and your limits. Recent viewer reports are untrusted observations, never proof of health. No target: always yours."],
  ["preview_web_appearance", schemas.PreviewWebAppearanceArgs,
    "Draw how you appear on the web dashboard as an SVG per mode (your card, the chat header with your face and ring, a pair of bubbles in your colours, your working label), written to .agend/appearance/<mode>.svg in your working directory, with the pictures it shows beside it (avatar, portrait, banner, background). Returns the paths: Read the SVGs for geometry, colours and text, and the pictures as images."],
  ["set_web_widget", schemas.SetWebWidgetArgs,
    "Place a widget in your own chat header or Details page, or give it new values: a declarative spec of the dashboard's own components (stat, progress, text, list, badge, spark) and the data they show — no HTML, script or CSS; it takes your theme's colours. Returns { slot, widget, rev } or { errors: [{ path, problem }] }. Refused while a person has locked your theme."],
  ["remove_web_widget", schemas.RemoveWebWidgetArgs,
    "Remove your own widget from one slot, or both (a change for the rate limit). A widget a person placed stays."],
  ["set_web_ambient", schemas.SetWebAmbientArgs,
    "Set your own ambient effect on the web dashboard: a preset (fall, rise, twinkle, burst-on-click) with your glyphs, colours and a few numbers — data only; the dashboard draws it behind your chat (falling petals 🌸❀✿, snow, click stars ✦✧). No code, no consent or preview needed, unlike a Canvas Worker effect. A chat has one looping ambient and one burst-on-click. Shown only where a person shows agents' looks (it plays with the system's reduced motion on, unless that device chose to follow it). Returns { kind, ambient, rev } or { errors: [{ path, problem }] }. A change for the rate limit; refused while a person locked your look or set that ambient."],
  ["clear_web_ambient", schemas.ClearWebAmbientArgs,
    "Clear your own ambient effect: the looping one, the click one, or both (a change for the rate limit). One a person set stays."],
  ["export_web_mod", schemas.ExportWebModArgs,
    "Export your own look on the web dashboard as a mod file — your theme with its pictures, your card text and the widgets you placed (never custom CSS) — written to .agend/mods/<name>-<version>.agendmod.json in your working directory. Returns { path, bytes }."],
  ["propose_web_mod", schemas.ProposeWebModArgs,
    "Propose a mod file from your working directory for a person to review in Settings → Look → Mods. It is checked whole; one carrying custom CSS is refused. Nothing changes until a person installs it."],
  ["reset_web_theme", schemas.ResetWebThemeArgs,
    "Reset your own web theme to the default (counts as a change for the rate limit)."],
  ["upload_web_effect", schemas.UploadWebEffectArgs,
    "Upload a Canvas Worker effect directory from your own workspace. Code runs only in an isolated Worker, with no DOM or network. Returns { id, warnings }; <=1 MiB normalized, ten uploads/eight MiB retained (uploads themselves are not counted). No target."],
  ["list_web_effects", schemas.ListWebEffectsArgs,
    "List your own effects and human-shared effects, their declarations, byte sizes, recorded profiles and closed recent blocked reasons for effects placed in your own chat. No viewer identities or counts; absence of reports means unknown. No target."],
  ["preview_web_effect", schemas.PreviewWebEffectArgs,
    "Offer a Try card for an effect you can read, in your own chat: only an admin signed in outside the public link can click to start a clipped sample, never you. Nothing is applied or saved; the offer lasts up to 10 minutes (offering the same effect again keeps it, a different one replaces it). Returns { id, status: \"offered\", expiresAt }, or not_found / trial_unavailable. It never launches a browser for you."],
  ["profile_web_effect", schemas.ProfileWebEffectArgs,
    "Read how an effect you can read ran on viewers' pages, per device class: { status: \"unmeasured\" | \"reported\", records } with a verdict (ok, degraded, paused, off) and a reason. No measurement means unknown, never free or healthy."],
  ["apply_web_effect", schemas.ApplyWebEffectArgs,
    "Apply an effect to your own chat only, with typed params if declared. At most two placements; shared theme-change rate limit and human lock apply. Owner regions and cursors are not agent settings."],
  ["remove_web_effect", schemas.RemoveWebEffectArgs,
    "Remove one effect from your own chat, or all (omit id). Shares the theme-change limit; a human lock is respected."],
  ["delete_web_effect", schemas.DeleteWebEffectArgs,
    "Delete your own unused effect claim. Any current placement, mod or live stage prevents deletion; another principal's claim is never removed."],
  ["set_description", schemas.SetDescriptionArgs,
    "Set your role description. This is injected into your system prompt as your role definition. Takes effect on next session restart."],
  ["checkout_repo", schemas.CheckoutRepoArgs,
    "Mount another repo as a detached-HEAD worktree. Returns a local path you can Read files from. Source must be an absolute or ~-prefixed path — instance names are not accepted; use describe_instance to get the working_directory first."],
  ["release_repo", schemas.ReleaseRepoArgs,
    "Remove a previously checked-out repo worktree."],
  ["deploy_template", schemas.DeployTemplateArgs,
    "Deploy a fleet template — creates instances and optionally a team in one operation."],
  ["teardown_deployment", schemas.TeardownDeploymentArgs,
    "Tear down a template deployment — stops and deletes all instances and team."],
  ["list_deployments", schemas.ListDeploymentsArgs,
    "List active template deployments with their instances and status."],
];

/** The runtime schemas, including internal routing fields, for every MCP tool. */
export const OUTBOUND_TOOL_SCHEMAS: ReadonlyMap<string, ZodType> = new Map(
  DEFS.map(([name, schema]) => [name, schema]),
);

// Derive routing capability from the schemas themselves. A new schema with a
// chat_id is covered without adding its name to a second whitelist.
const channelAddressTools = new Set(DEFS
  .filter(([, schema]) => Object.hasOwn(z.toJSONSchema(schema).properties ?? {}, "chat_id"))
  .map(([name]) => name));

export function usesChannelAddress(tool: string): boolean {
  return channelAddressTools.has(tool);
}

export const TOOLS: ToolDef[] = DEFS.map(([name, schema, description]) => ({
  name,
  description,
  inputSchema: toToolInputSchema(schema),
}));

/**
 * The profiles live in `src/tool-permissions.ts` now, with the permission check
 * that uses them. A tool list that only one of four entry paths consults is not
 * a control, so it stopped being defined next to the schemas and moved next to
 * the thing that enforces it.
 */

/** #2275: keep non-CW appearance tools useful without advertising disabled branches. */
export function toolsWithCanvasWorker(enabled: boolean, definitions: readonly ToolDef[] = TOOLS): ToolDef[] {
  if (enabled) return [...definitions];
  const descriptions: Readonly<Record<string, string>> = {
    get_web_settings: "Read Settings → Look: themes, colours, cards, widgets, custom CSS and ambient presets. General, coordinators and full profiles.",
    set_web_settings: "Change Settings → Look: host settings, colours, cards, custom CSS, ambient presets, or Restore defaults. General, coordinators and full profiles.",
    get_web_appearance: "Read your own appearance on the dashboard: face, ring colour, identity card, theme, widgets, ambient presets and limits.",
    set_web_ambient: "Set your own ambient preset (fall, rise, twinkle, burst-on-click) with glyphs, colours and numbers. Declarative data only; no code or preview is needed. Shares the theme-change limit and respects a person's lock.",
  };
  return definitions.filter(t => !isCanvasWorkerTool(t.name)).map(t => {
    const schema = structuredClone(t.inputSchema);
    if (t.name === "set_web_settings") {
      const change = schema.properties?.change as Record<string, unknown> | undefined;
      for (const key of ["oneOf", "anyOf"]) {
        if (Array.isArray(change?.[key])) change[key] = (change[key] as Array<{ properties?: { what?: { const?: string } } }>).filter(branch => !["effect", "effect_slot", "mod"].includes(branch.properties?.what?.const ?? ""));
      }
    }
    // `person` is shared with effect slots in the on schema; no disabled capability leaks via nested descriptions.
    const stripDescriptions = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") {
          (node as Record<string, unknown>)[key] = value.replace(/custom CSS, effect slots/g, "custom CSS").replace(/themes, effects and widgets/g, "themes and widgets");
        } else stripDescriptions(value);
      }
    };
    stripDescriptions(schema);
    return { ...t, description: descriptions[t.name] ?? t.description, inputSchema: schema };
  });
}

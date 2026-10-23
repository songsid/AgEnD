/**
 * zod schemas for outbound tool-call args.
 *
 * Single source of truth for both runtime validation (in outbound-handlers.ts)
 * and JSON Schema generation for MCP tool listings (in channel/mcp-tools.ts).
 */
import { z } from "zod";

// ── Shared field schemas ────────────────────────────────────────────────
// Reused across multiple tools; declaring once avoids drift.

const NonEmptyString = z.string().min(1);

const MessageFormat = z.enum(["text", "markdown"]);

// Internal routing metadata, filled by the daemon/fleet rather than the model.
// Only channel-addressing schemas accept it; mcp-tools omits it from listings.
const ChannelAddressFields = {
  chat_id: z.string().optional(),
  thread_id: z.string().optional(),
};

// ── Channel interaction (handled outside outbound-handlers.ts) ──────────

export const ReplyArgs = z.object({
  ...ChannelAddressFields,
  text: z.string().optional()
    .describe("The message. Required unless you send stickers; with stickers it may be omitted."),
  reply_to: z.string().optional()
    .describe("Message ID to thread under. Use message_id from the inbound block."),
  files: z.array(z.string()).optional()
    .describe("Absolute file paths to attach (at most 20). Files under the AgEnD state dir (~/.agend, incl. workspaces/) are refused — copy an artifact to /tmp first and attach that. For HTML the web chat should preview, attach a .html file (up to 1 MiB) rather than pasting the page into text: a long ```html block is split on Discord/Telegram; keep ```html blocks for short snippets."),
  format: MessageFormat.optional().describe("Rendering mode. Default: 'text'."),
  stickers: z.array(NonEmptyString).max(3).optional()
    .describe("Up to 3 sticker ids from list_stickers, sent with the text (Discord: the same message; Telegram: after it). Stickers are never written in the text."),
  buttons: z.array(z.object({
    label: z.string().min(1).max(80).describe("What the button says: one line of plain text, at most 80 characters."),
    value: z.string().max(200).optional().describe("What you receive when it is clicked, if not the label (at most 200 characters; never shown on the platform)."),
  })).min(1).max(10).optional()
    .describe("Up to 10 buttons under the text (needs text; not with stickers). The first click by someone who may talk to you there answers for everyone and comes back to you as a message: `[button] <label>` (and `(value: …)` when it differs). Unanswered buttons expire after 24 h. With `poll`, they are a poll's options instead."),
  poll: z.object({
    seconds: z.number().int().min(10).max(86400).describe("When the poll closes: 10 s to 24 h after it is posted."),
    multi: z.boolean().optional().describe("Each voter may pick several options (a click toggles one). Default: one."),
    reveal: z.enum(["close", "live"]).optional().describe("\"close\" (default): while open only \"N answered\" and the time left show, the counts at close. \"live\": the counts show as votes come."),
    show_voters: z.boolean().optional().describe("At close, also post who picked what in the chat. Default: counts only. You get the voters either way."),
  }).optional()
    .describe("Make the buttons (2–10) a timed poll: everyone who may talk to you there votes once, may change their vote, and is told their own choice privately. At the deadline you get one message from AgEnD in the poll's chat, `[poll results]`: each option's count and voters, each with an id and the ms from the poll opening (just before it is posted) to their last change; answer it in the chat. AgEnD only counts votes: post the right answer and any scores yourself. The reply's result has `poll_id`."),
});

// #1823: early close of one of the caller's polls.
export const ClosePollArgs = z.object({
  poll_id: z.string().regex(/^[0-9a-f]{32}$/).describe("The poll_id the reply that opened the poll returned."),
});

export const ReactArgs = z.object({
  ...ChannelAddressFields,
  message_id: NonEmptyString,
  emoji: NonEmptyString,
});

export const EditMessageArgs = z.object({
  ...ChannelAddressFields,
  message_id: NonEmptyString,
  text: NonEmptyString,
  format: MessageFormat.optional().describe("Rendering mode, as for reply. Default: 'text'. Tables and code blocks don't re-render on edit."),
});

export const DownloadAttachmentArgs = z.object({
  ...ChannelAddressFields,
  file_id: NonEmptyString.describe("The attachment_file_id from inbound meta"),
});

export const ValidateConfigArgs = z.object({});

// ── Schedules ───────────────────────────────────────────────────────────

export const CreateScheduleArgs = z.object({
  cron: NonEmptyString.optional()
    .describe("Recurring cron expression, e.g. '0 7 * * *'. Mutually exclusive with at."),
  at: z.string().datetime({ offset: true }).optional()
    .describe("One-shot ISO-8601 datetime with offset, e.g. '2026-07-26T14:00:00+08:00'. Mutually exclusive with cron."),
  message: NonEmptyString.describe("Message to inject when triggered"),
  target: z.string().optional()
    .describe("Target instance name. Defaults to this instance if omitted. Targeting another instance needs the full, coordinator or general tool set."),
  label: z.string().optional().describe("Human-readable name for this schedule"),
  timezone: z.string().optional()
    .describe("IANA timezone, e.g. 'Asia/Taipei'. Defaults to the fleet's defaults.scheduler.default_timezone (Asia/Taipei unless set)."),
  silent: z.boolean().optional()
    .describe("Silent mode: inject directly into the agent's tmux pane without posting to the channel. Useful for heartbeat or background tasks."),
}).refine(data => (data.cron ? 1 : 0) + (data.at ? 1 : 0) === 1, {
  message: "Exactly one of cron or at is required",
  path: ["cron"],
});

export const ListSchedulesArgs = z.object({
  target: z.string().optional().describe("Filter by target instance name"),
});

export const UpdateScheduleArgs = z.object({
  id: NonEmptyString.describe("Schedule ID"),
  cron: NonEmptyString.optional().describe("New recurring cron expression; clears at"),
  at: z.string().datetime({ offset: true }).optional().describe("New one-shot ISO datetime; clears cron"),
  message: z.string().optional().describe("New message"),
  target: z.string().optional().describe("New target instance"),
  label: z.string().optional().describe("New label"),
  timezone: z.string().optional().describe("New timezone"),
  enabled: z.boolean().optional().describe("Enable/disable the schedule"),
}).refine(data => !(data.cron && data.at), {
  message: "cron and at are mutually exclusive",
  path: ["cron"],
});

export const DeleteScheduleArgs = z.object({
  id: NonEmptyString.describe("Schedule ID to delete"),
});

// ── Fleet Task Board ────────────────────────────────────────────────────

export const TaskBoardArgs = z.object({
  action: z.enum(["create", "list", "claim", "done", "update", "get", "mine", "move", "projects"])
    .describe("Operation to perform"),
  title: z.string().optional().describe("Task title (create/update)"),
  description: z.string().optional().describe("Task details; a board card's goal (create/update)"),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional()
    .describe("Priority (create/update)"),
  assignee: z.string().optional().describe("Instance name to assign (create/update)"),
  depends_on: z.array(z.string()).optional()
    .describe("Task IDs this depends on (create)"),
  id: z.string().optional().describe("Task ID, 8-hex id prefix, or card number like M-3 (claim/done/update/get)"),
  result: z.string().optional().describe("Completion summary (done)"),
  status: z.enum(["open", "claimed", "review", "done", "blocked", "cancelled"]).optional()
    .describe("New status (update)"),
  filter_assignee: z.string().optional().describe("Filter by assignee (list)"),
  filter_status: z.union([
    z.enum(["open", "claimed", "review", "done", "blocked", "cancelled"]),
    z.array(z.enum(["open", "claimed", "review", "done", "blocked", "cancelled"])),
  ]).optional()
    .describe("Filter by status (list) — a single status or an array of statuses. Omit for live-only (open/claimed/blocked/review)."),
  verbose: z.boolean().optional()
    .describe("list: return full task records instead of compact rows (default false)"),
  // The task board (docs/design/task-board.md): naming one of these makes create/update a board card's.
  project: z.union([z.string(), z.number().int()]).optional().describe("Project name or id: a new main task's (create), a filter (list)"),
  parent: z.string().optional().describe("Main task number like M-3: a new sub task's (create), its sub tasks (list)"),
  scope: z.string().optional().describe("Main task: in / out of scope (create/update)"),
  acceptance: z.array(z.string()).optional().describe("Checklist that defines done, one item each (create/update replaces it)"),
  check: z.array(z.number().int()).optional().describe("Acceptance items to tick, 1-based (update)"),
  uncheck: z.array(z.number().int()).optional().describe("Acceptance items to untick, 1-based (update)"),
  context: z.string().optional().describe("Pointers only: paths, related cards, decisions (create/update)"),
  state: z.string().optional().describe("Overwritten each time: done / next / watch out, at most 5 lines (update)"),
  log: z.string().optional().describe("One progress line appended to the card's log (update)"),
  comment: z.string().optional().describe("A comment on the card (update/move)"),
  needs_review: z.boolean().optional().describe("Stop at review when finished, for whoever confirms it: the person on a card they handed out, else its dispatcher (create/update)"),
  size: z.enum(["S", "M", "L"]).optional().describe("S small, M one unit, L too big: split it (create/update)"),
  dispatcher: z.string().nullable().optional().describe("Who handed the work out (an instance, e.g. your lead); a blocked card's question goes to them first. Default: the main task's, or you when you assign it to someone else (create/update)"),
  to: z.enum(["open", "claimed", "review", "done", "blocked", "cancelled"]).optional().describe("New status (move)"),
  reason: z.string().optional().describe("move: why blocked (who must answer what), cancelled, or acceptance left unchecked"),
  version: z.number().int().optional().describe("The card version you read; a newer one refuses the write (update/move)"),
});

// ── Shared Decisions ────────────────────────────────────────────────────

export const PostDecisionArgs = z.object({
  title: NonEmptyString.describe("Short title for the decision"),
  content: NonEmptyString.describe("Full decision description"),
  scope: z.enum(["project", "fleet"]).optional()
    .describe("'project' (default) = same working directory. 'fleet' = all instances."),
  tags: z.array(z.string()).optional()
    .describe("Optional tags for categorization"),
  ttl_days: z.number().optional()
    .describe("Days until auto-archive. Default: permanent. Set e.g. 7 for temporary decisions."),
  supersedes: z.string().optional()
    .describe("Decision ID to supersede (marks old one as superseded)"),
});

export const ListDecisionsArgs = z.object({
  include_archived: z.boolean().optional()
    .describe("Include archived/superseded decisions. Default: false"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  id: z.string().optional().describe("One decision's full text, by its id (or a unique prefix of 6+ characters)"),
  full: z.boolean().optional().describe("Every decision's full text (large: prefer titles, then { id } for the ones you need). Default: false — titles only"),
});

export const UpdateDecisionArgs = z.object({
  id: NonEmptyString.describe("Decision ID"),
  content: z.string().optional().describe("Updated content"),
  tags: z.array(z.string()).optional().describe("Updated tags"),
  ttl_days: z.number().optional().describe("Updated TTL in days"),
  archive: z.boolean().optional().describe("Set to true to archive this decision"),
});

// ── Identity ────────────────────────────────────────────────────────────

export const SetDisplayNameArgs = z.object({
  name: NonEmptyString.describe("Your chosen display name"),
});

export const ListEmojisArgs = z.object({
  refresh: z.boolean().optional().describe("Refetch the Discord server emoji lists instead of using the cache"),
  name: z.string().max(64).optional().describe("Only server emojis whose name contains this (case-insensitive)"),
  limit: z.number().int().min(1).max(500).optional().describe("At most this many server emojis in all (default: all of them)"),
  primary_only: z.boolean().optional().describe("Only the primary server's emojis, not those of the other servers the bot is in"),
  with_image_urls: z.boolean().optional().describe("Include each server emoji's image URL (default: no — preview_emojis shows them)"),
});

export const ListStickersArgs = z.object({
  set: z.string().max(64).optional()
    .describe("Telegram: the sticker set to list (the <name> in t.me/addstickers/<name>); default: the channel's sticker_sets. Discord: not used — you get your channel's server's stickers"),
  name: z.string().max(64).optional().describe("Only stickers whose name, tags or emoji contain this (case-insensitive)"),
  limit: z.number().int().min(1).max(200).optional().describe("At most this many stickers (default: all of them)"),
  refresh: z.boolean().optional().describe("Refetch instead of using the cache"),
});

export const PreviewStickersArgs = z.object({
  stickers: z.array(NonEmptyString).min(1).max(8)
    .describe("Up to 8 sticker ids from list_stickers; narrow them down by name first"),
});

export const PreviewEmojisArgs = z.object({
  emojis: z.array(z.string()).min(1).max(8)
    .describe("Up to 8 server emojis as <:name:id> from list_emojis; narrow them down by name first"),
});

export const SetPersonaEmojiArgs = z.object({
  emoji: z.string().describe(
    "One emoji, or a Discord server emoji as <:name:id> from list_emojis. Empty string removes your override for that status.",
  ),
  status: z.enum(["received", "queued", "processing", "delivered", "failed", "progress_prefix", "photo", "attachment"]).optional()
    .describe("Which of your status stamps to set (default: delivered, the one that stays on a handled message). progress_prefix is not a reaction: it is the emoji at the start of your progress message."),
});

// ── #1629: your own web theme (no target: always the caller's) ─────────────

export const GetWebThemeArgs = z.object({});
export const SetWebThemeArgs = z.object({
  set: z.record(z.string(), z.unknown()).optional()
    .describe("Theme fields to set, merged into your current theme: colors.light|dark.{bg,surface,text,text2,accent,userBubble,agentBubble} as #rrggbb, accent, bubble.{radius 0..24, border none|thin|accent}, font inter|system|mono, background {image: asset id, fit cover|contain, opacity 0.05..1}, avatar (asset id), workingLabel (1..24 characters), card.{portrait, banner} (asset ids uploaded for those slots), card.tagline (1..60 characters, one line), card.bio (1..280 characters, at most 3 line breaks), card.bannerFocus (0 top … 100 bottom: which part of your banner stays in view when it is cropped; 50 the centre), page.on (true: your colours on the whole page — the sidebar, the header, the usage rail, a phone's tabs — while your chat is open; a person's choice wins; text, accent and AgEnD's status colours must read on it), page.sidebar.light|dark (#rrggbb; else your bg)"),
  clear: z.array(z.string().max(64)).max(32).optional().describe("Dotted paths to remove, e.g. [\"colors.dark.bg\", \"workingLabel\"]"),
});
export const SetWebThemeAssetArgs = z.object({
  slot: z.enum(["background", "avatar", "portrait", "banner", "glyph"]).describe("What the picture is for: your theme's background or avatar, your identity card's portrait or banner, or a glyph for your ambient (set_web_ambient)"),
  file: NonEmptyString.describe("A picture in your working directory: png, jpeg, webp or gif for background (≤ 512 KiB) and avatar (≤ 256 KiB), ≤ 4096 px a side; png, jpeg or webp for portrait and banner (limits set by the fleet — get_web_theme's limits.asset_slots says the ones in force)"),
});
export const ResetWebThemeArgs = z.object({});
// #1629 r4 §1: how you appear on the dashboard — read-only, always yours.
export const GetWebAppearanceArgs = z.object({});
export const PreviewWebAppearanceArgs = z.object({
  modes: z.array(z.enum(["light", "dark"])).min(1).max(2).optional().describe("Which modes to draw (default both)"),
});
// #1629 r4-4: your own widgets — declarative (a spec of host components and the values they show), always yours.
export const SetWebWidgetArgs = z.object({
  slot: z.enum(["chat_header", "details"]).describe("chat_header: a strip under your chat header (at most 4 of stat, progress, text, badge); details: a card on your Details page (at most 8 items, any type)"),
  spec: z.record(z.string(), z.unknown()).optional()
    .describe("Place or replace the widget: { v: 1, title (1..24 characters), items: [{ type: stat|progress|text|list|badge|spark, label?, key (a name in your data) or bind (state, context_pct, cost_usd), unit? (stat), max? (progress, default 100), tone?/tones? (badge: ok|warn|bad|info|muted) }] }. A change for the rate limit. See the web-appearance skill."),
  data: z.record(z.string(), z.unknown()).optional()
    .describe("Values by key: a number, a line of text, a list of lines (list) or numbers (spark). With spec: the widget's values. Alone: merged into the placed widget's values (null removes a key) — its own budget, 10 s apart."),
});
// #2117: your own ambient — declarative (a preset and its glyphs; the dashboard draws it), always yours.
// #2155: fixed-length plain arrays, never z.tuple — a tuple serialises to `prefixItems` (2020-12; `$schema` is stripped
// for clients), which codex turns into `Array<string>`. tests/tool-schema-portability-2155.test.ts keeps it out.
const AmbientRange = z.array(z.number()).length(2);
export const SetWebAmbientArgs = z.object({
  preset: z.enum(["fall", "rise", "twinkle", "burst-on-click"]).describe("fall / rise: particles drifting down or up behind your chat, endlessly; twinkle: glyphs pulsing in place; burst-on-click: glyphs scatter from where a person clicks or taps. A chat has one looping ambient (fall, rise or twinkle) and one burst-on-click: setting one replaces only its own kind"),
  glyphs: z.array(z.union([z.string().max(32), z.object({ asset: z.string() }).strict()])).min(1).max(4).describe("1..4 glyphs, picked at random per particle: a short string of 1..2 characters (an emoji, ✦, ❀), or { asset: <id> } — a picture you uploaded with set_web_theme_asset slot glyph (png, webp or gif, ≤ 64 KiB, ≤ 128 px)"),
  colors: z.array(z.string()).max(5).optional().describe("0..5 colours #rrggbb for text glyphs, picked at random per particle (default: your theme's accent)"),
  count: z.number().int().optional().describe("Particles: 1..24 for fall, rise and twinkle (default 12); per click for burst-on-click 4..16 (default 10)"),
  duration: AmbientRange.optional().describe("[min, max] seconds of one particle's run: fall/rise 4..30 (default [9, 19]), twinkle 1..10 ([2, 5]), burst-on-click 0.3..2 ([0.5, 0.9])"),
  size: AmbientRange.optional().describe("[min, max] px, 10..40 (default [14, 22])"),
  sway: z.number().optional().describe("Sideways drift in px for fall and rise, 0..80 (default 40)"),
  spread: AmbientRange.optional().describe("[min, max] px a burst scatters, 20..120 (default [34, 90])"),
  rotate: z.number().optional().describe("Degrees a particle turns over its run, 0..720 (default 300)"),
  opacity: z.array(z.number()).length(3).optional().describe("[start, peak, end], each 0..1 (default [0, 0.85, 0.15])"),
  layer: z.literal("behind").optional().describe("Always behind your chat's messages (a burst shows over them briefly, never taking a click)"),
}).strict();
export const ClearWebAmbientArgs = z.object({
  which: z.enum(["loop", "click"]).optional().describe("loop (fall, rise, twinkle) or click (burst-on-click); default both. One a person set stays."),
}).strict();
// #1629 r4-5b: mods — your own look as a file, and proposing one for a person to review. Agents never import.
export const ExportWebModArgs = z.object({
  name: NonEmptyString.describe("The mod's name: a-z, 0-9 and - (1..64)"),
  version: NonEmptyString.describe("MAJOR.MINOR.PATCH, e.g. 1.0.0"),
  title: z.string().optional().describe("A title for people (1..60 characters; default: the name)"),
});
export const ProposeWebModArgs = z.object({
  file: NonEmptyString.describe("A .agendmod.json file in your working directory (at most 8 MiB, no custom CSS)"),
});
export const RemoveWebWidgetArgs = z.object({
  slot: z.enum(["chat_header", "details"]).optional().describe("The slot to empty (default both). A widget a person placed stays."),
});

// #1629 CW1 effects: own caller only. Internal upload bytes are never public MCP args.
export const UploadWebEffectArgs = z.object({
  dir: z.string().min(1).max(4096).describe("A CW1 directory in your working directory: effect.json, worker.js, optional poster/cursor and at most sixteen raster assets. No HTML or CSS; normalized size <=1 MiB."),
}).strict();
export const ListWebEffectsArgs = z.object({}).strict();
export const PreviewWebEffectArgs = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
export const ProfileWebEffectArgs = PreviewWebEffectArgs;
export const ApplyWebEffectArgs = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  params: z.record(z.string().max(32), z.union([z.string().max(128), z.number().finite(), z.boolean()])).optional().describe("Typed overrides declared by the effect; unknown keys or out-of-range values refuse the whole apply."),
}).strict();
export const RemoveWebEffectArgs = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict();
export const DeleteWebEffectArgs = PreviewWebEffectArgs;

export const SetDescriptionArgs = z.object({
  description: NonEmptyString.describe(
    "Your role description, e.g. 'Code reviewer focused on security and error handling'",
  ),
});

// ── Repo checkout ───────────────────────────────────────────────────────

export const CheckoutRepoArgs = z.object({
  source: NonEmptyString.describe("Repo path (absolute or ~-prefixed path). Instance names are not accepted — use describe_instance to get the working_directory first."),
  branch: z.string().optional().describe("Branch or commit to checkout. Default: HEAD."),
});

export const ReleaseRepoArgs = z.object({
  path: NonEmptyString.describe("Path returned by checkout_repo."),
});

// ── Instance management ─────────────────────────────────────────────────

export const ListInstancesArgs = z.object({
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  name: z.string().optional().describe("Filter by name (fuzzy match, contains) — also matches display_name"),
  backend: z.string().optional().describe("Filter by backend (exact match)"),
  status: z.enum(["running", "paused", "stopped"]).optional().describe("Filter by status"),
});

export const DescribeInstanceArgs = z.object({
  name: NonEmptyString.describe("Instance name to describe."),
});

export const StartInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to start (from list_instances)"),
});

export const RestartInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to restart"),
});

export const PauseInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to pause"),
});

export const WakeInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to wake"),
});

export const StopInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to stop"),
});

export const GetFleetStatusArgs = z.object({});

export const GetEffortArgs = z.object({
  name: NonEmptyString.optional().describe("Instance to inspect. Defaults to the calling instance."),
});

export const KiroEngineStatusArgs = z.object({
  name: NonEmptyString.optional().describe("One kiro instance. Omit for every kiro instance in the fleet."),
});

export const GetUsageArgs = z.object({
  force: z.boolean().optional().describe("Bypass the 5-minute cache and fetch fresh data (rate-limited by vendors — use sparingly)"),
});

// #2056: Settings → Web appearance for the user — General, a coordinator or a full profile; the page's own checks.
const Person = NonEmptyString.optional()
  .describe("Whose own settings (custom CSS, effect slots): a `person` from get_web_settings' people — the one whose platform id is the user's. Default: the host operator. Host settings are everyone's on this host.");
const Places = z.array(z.enum(["name", "bar", "ring"])).max(3);
export const GetWebSettingsArgs = z.object({ person: Person }).strict();
export const SetWebSettingsArgs = z.object({
  person: Person,
  change: z.discriminatedUnion("what", [
    z.object({
      what: z.literal("host"),
      set: z.object({
        themes_shown: z.boolean().nullable().optional().describe("Show agents' themes, effects and widgets (null: the default, shown)"),
        card_size: z.enum(["s", "m", "l"]).nullable().optional().describe("Identity cards' size (null: the default, m)"),
        card_sizes: z.record(z.string(), z.enum(["s", "m", "l"])).nullable().optional().describe("Cards set apart from it: { <instance>: s|m|l } (null: none)"),
        page_colours: z.record(z.string(), z.enum(["page", "chat"])).nullable().optional().describe("Where agents' theme colours go, set apart from each agent's own choice: { <instance>: page (the whole page) | chat (only its chat) } (null: every agent's own)"),
        colour_places: Places.nullable().optional().describe("Where identity colours show where nobody chose: name, bar, ring ([] nowhere; null: the default, all three)"),
        colours_off: z.boolean().nullable().optional().describe("Turn every identity colour off on this host (picks are kept)"),
        sidebar_widget: z.object({ spec: z.record(z.string(), z.unknown()), data: z.record(z.string(), z.unknown()) }).strict().nullable().optional()
          .describe("The sidebar widget: { spec, data }, the same spec as set_web_widget's, binds fleet.working / needs_you / idle / stopped (null removes it)"),
      }).strict(),
    }).strict(),
    z.object({
      what: z.literal("banner_focus"), instance: NonEmptyString,
      focus: z.number().int().min(0).max(100).nullable().describe("Which part of that agent's cropped banner stays in view: 0 top … 100 bottom (50 the centre); null follows the agent's own"),
    }).strict(),
    z.object({
      what: z.literal("page_colours"), instance: NonEmptyString,
      choice: z.enum(["agent", "page", "chat"]).describe("Where that agent's theme colours go while its chat is open: page (the whole page: sidebar, header, usage rail, a phone's tabs), chat (only its chat), or agent (its own choice, theme.page.on)"),
    }).strict(),
    z.object({
      what: z.literal("agent_colour"), instance: NonEmptyString,
      colour: z.string().nullable().optional().describe("preset:<name> or #rrggbb (null: back to the agent's, its bot's or the automatic one)"),
      places: Places.nullable().optional().describe("Where that agent's colour shows ([] nowhere; null: back to the host's places)"),
    }).strict(),
    z.object({
      what: z.literal("custom_css"), action: z.enum(["save", "keep", "revert", "use", "off"]),
      text: z.string().optional().describe("save: the stylesheet (same rules as the page: no remote URLs, assets as url(\"asset:<id>\"), at most 64 KiB). It goes on trial: it waits until they open the dashboard (up to 10 minutes), then goes back by itself 20 s after it is on their screen unless kept — keep it (keep, with the trial id save returned) once they say they like it; kept after it went back, it is put back in force (as use)."),
      version: z.string().optional().describe("use: an earlier saved version's sha, from get_web_settings' custom_css.versions; it applies at once"),
      trial: z.string().optional().describe("keep: the trial's id, as save returned it (or get_web_settings' custom_css.trial); a different trial on now is not kept"),
    }).strict(),
    z.object({
      what: z.literal("mod"), action: z.enum(["review", "install", "cancel", "dismiss", "uninstall"]),
      instance: z.string().optional().describe("review / dismiss: the agent whose proposal it is"),
      stage: z.string().optional().describe("install / cancel: from review"), plan_hash: z.string().optional().describe("install: from review"),
      include: z.record(z.string(), z.unknown()).optional().describe("install: the parts to apply, as the plan names them (custom CSS only when you mean it)"),
      target: z.string().optional().describe("install: the agent the look applies to"),
      id: z.string().optional().describe("uninstall: an installed mod's id"),
    }).strict(),
    z.object({
      what: z.literal("effect"), action: z.enum(["apply", "remove"]), instance: NonEmptyString,
      id: z.string().optional().describe("apply: the effect's id; remove: one id (omit for all)"),
      params: z.record(z.string(), z.unknown()).optional().describe("apply: typed params the effect declares"),
    }).strict(),
    z.object({
      what: z.literal("effect_slot"), slot: z.enum(["sidebar", "header", "page", "box", "cursor"]),
      id: z.string().nullable().describe("An effect id from the library for that slot, or null to clear it"),
    }).strict(),
    z.object({
      what: z.literal("ambient"), instance: NonEmptyString,
      ambient: z.record(z.string(), z.unknown()).nullable().describe("That agent's ambient effect, set for the user: the same spec as set_web_ambient's ({ preset, glyphs, colors?, count?, … }); it replaces the one of its kind (loop or click) and the agent can't change it after. null clears"),
      which: z.enum(["loop", "click"]).optional().describe("With ambient: null — which one to clear (default both)"),
    }).strict(),
    z.object({ what: z.literal("restore_defaults") }).strict(),
  ]),
}).strict();

/** #2001: the prompt-cache expiry / keep-warm report, read-only. */
export const GetCacheReportArgs = z.object({
  window: z.enum(["24h", "7d", "30d"]).optional().describe("The period to analyse. Default: 7d."),
  instance: NonEmptyString.optional().describe("One instance's row. An ordinary instance may name only itself (its row is the default)."),
  top: z.number().int().min(1).max(50).optional().describe("At most this many analysed instances, the costliest expiries first. Default: 10."),
}).strict();

/** #2122: tokens, requests, delivered messages and their API-equivalent at list price, read-only. */
export const GetUsageReportArgs = z.object({
  range: z.enum(["today", "7d", "month", "all", "custom"]).optional().describe("The days to sum, in the fleet's timezone. Default: 7d. custom needs from and to."),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("custom: the first day, YYYY-MM-DD."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("custom: the last day, YYYY-MM-DD."),
  group: z.enum(["instance", "backend", "model", "profile", "team"]).optional().describe("How rows are grouped. Default: instance. team is by current membership."),
  instance: NonEmptyString.optional().describe("One instance's row. An ordinary instance may name only itself (its row is the default)."),
  top: z.number().int().min(1).max(50).optional().describe("At most this many rows, the largest first. Default: 10."),
}).strict();

export const ListModelsArgs = z.object({
  backend: NonEmptyString.optional()
    .describe("Backend to list the account catalog for (claude-code, kiro-cli, codex, grok, opencode, antigravity). Defaults to the fleet default backend."),
  instance_name: NonEmptyString.optional()
    .describe("List through this instance's own backend config instead. Prefer this before setting a model on an existing instance — an instance on a custom provider can have a different catalog from the account."),
});

export const GetInstanceLogsArgs = z.object({
  name: NonEmptyString.describe("The instance name to get logs for"),
  lines: z.number().int().positive().optional().describe("Number of lines to return (default: 50, max 200)"),
});

export const GetFleetConfigArgs = z.object({
  scope: z.enum(["defaults", "instance"]).optional().describe("Config scope: 'defaults' for fleet defaults, 'instance' for a specific instance"),
  name: z.string().optional().describe("Instance name (required when scope='instance')"),
});

export const UpdateInstanceConfigArgs = z.object({
  name: NonEmptyString.describe("Instance name to update"),
  config: z.object({
    backend: z.string().optional().describe("CLI backend. A switch restarts a running instance in a fresh session (a stopped or paused one stays so, and starts on it next time), and drops the instance's own model and effort: give `model` here for the new backend, or it inherits the fleet default, else that backend's own default."),
    model: z.string().optional().describe("Model override. With a backend switch: a model the new backend takes, else the switch is refused."),
    resume_interrupted_work: z.boolean().optional().describe("Automatically continue known interrupted work after a stable restart"),
    auto_pause_after: z.number().optional().describe("Minutes idle before auto-pause (0 = disabled)"),
    display_name: z.string().optional().describe("Display name"),
    description: z.string().optional().describe("Role description"),
    backend_options: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe(
      "Backend-specific options keyed by backend name. Use { \"kiro-cli\": { \"credential_profile\": \"work\" } } to move this agent to another subscription — the instance is restarted so the new login takes effect.",
    ),
  }).describe("Fields to merge-patch into the instance config"),
});

export const UpdateFleetDefaultsArgs = z.object({
  defaults: z.object({
    backend: z.string().optional().describe("Default CLI backend"),
    model: z.string().optional().describe("Default model"),
    resume_interrupted_work: z.boolean().optional().describe("Automatically continue known interrupted work after a stable restart"),
    auto_pause_after: z.number().optional().describe("Default auto-pause minutes (0 = disabled)"),
    max_cross_instance_message_bytes: z.number().int().positive().optional()
      .describe("Maximum UTF-8 byte size of one cross-instance message body (default 12288)"),
  }).describe("Fields to merge-patch into fleet defaults"),
});

export const DeleteInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to delete (from list_instances)"),
  delete_topic: z.boolean().optional()
    .describe("Whether to also delete the Telegram topic. Defaults to false."),
});

export const ReplaceInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to replace"),
  reason: z.string().optional()
    .describe("Why the instance is being replaced (e.g. 'context polluted', 'stuck in loop')"),
});

// create_instance accepts the externally documented fields. passthrough() keeps
// any unknown keys so internal callers (deploy_template) can forward extras
// (profile-derived fields, start_point, …) without the schema stripping them.
export const CreateInstanceArgs = z.object({
  directory: z.string().optional().describe(
    "Absolute path or ~-prefixed path to the project directory. Optional — omit to auto-create a workspace at ~/.agend/workspaces/<name>.",
  ),
  topic_name: z.string().optional().describe(
    "Name for the Telegram topic. Defaults to directory basename. Required when directory is omitted.",
  ),
  description: z.string().optional().describe(
    "Human-readable description of what this instance does (e.g., 'Daily secretary for scheduling and reminders').",
  ),
  model: z.string().optional().describe(
    "Model to use. Claude: sonnet, opus, haiku, opusplan, best, Fable, sonnet[1m], opus[1m]. Codex: gpt-4o, o3. Omit for default.",
  ),
  backend: z.enum(["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"]).optional()
    .describe("CLI backend to use. Defaults to claude-code."),
  backend_options: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe(
    "Backend-specific options keyed by backend name. For a Codex custom provider, use { codex: { provider: \"glm\" } }.",
  ),
  branch: z.string().optional().describe(
    "Git branch name. When specified, creates a git worktree from the directory's repo and uses it as the working directory. If the branch doesn't exist, it will be created.",
  ),
  detach: z.boolean().optional().describe(
    "Use detached HEAD (read-only). Useful for review instances that shouldn't commit to the branch.",
  ),
  worktree_path: z.string().optional().describe(
    "Custom path for the git worktree. Defaults to sibling directory of the repo.",
  ),
  systemPrompt: z.string().optional().describe(
    "Custom system prompt. Supports comma-separated file: paths for modularization (e.g. 'file:prompts/role.md, file:prompts/rules.md'); a relative path is relative to the new instance's working directory. Injected after fleet context.",
  ),
  tags: z.array(z.string()).optional().describe("Tags for categorization and filtering."),
  workflow: z.string().optional().describe(
    "Workflow template. 'builtin' (default), 'false' to disable, or custom text.",
  ),
}).passthrough();

// ── Cross-instance communication ────────────────────────────────────────

const ForwardMessageIds = z.array(z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/))
  .max(16).refine(ids => new Set(ids).size === ids.length, "Each forwarded message ID must appear only once")
  .optional().describe("Explicit message IDs to share read-only verification access with the receiver. You must already be able to read each delivered row. Mentioning an ID in text grants no access; every relay hop must forward it explicitly.");

export const SendToInstanceArgs = z.object({
  instance_name: NonEmptyString.describe(
    "Name of the target instance (e.g., 'ccplugin', 'blog-t1385'). Use list_instances to see available instances.",
  ),
  message: NonEmptyString.describe("The message to send to the target instance."),
  forwards: ForwardMessageIds,
  steer: z.boolean().optional().describe(
    "Inject as a supplement into the target's CURRENT turn — for correcting or adding to work you just sent. Omit for a new task. Safe: an idle target receives it normally; an unsupported backend falls back to the idle queue.",
  ),
  request_kind: z.enum(["query", "task", "report", "update"]).optional().describe(
    "Categorizes the message intent. 'query' = asking a question, 'task' = delegating work, 'report' = returning results, 'update' = status notification.",
  ),
  requires_reply: z.boolean().optional()
    .describe("Whether you expect the recipient to respond. Default: false."),
  correlation_id: z.string().optional()
    .describe("Echo this from a previous message to link request-response pairs."),
  task_summary: z.string().optional()
    .describe("Brief summary of the task or request (shown in logs and Telegram visibility posts)."),
  working_directory: z.string().optional()
    .describe("Working directory context to pass along (e.g. the repo path you are working in)."),
  branch: z.string().optional().describe("Git branch context to pass along."),
});


// broadcast excludes "report" (broadcasts don't reply to a specific correlation);
// send_to_instance accepts all four inline.
const BroadcastRequestKind = z.enum(["query", "task", "update"]);

export const BroadcastArgs = z.object({
  message: NonEmptyString.describe("Message to send"),
  targets: z.array(z.string()).optional().describe("Instance names. Omit for all running."),
  team: z.string().optional()
    .describe("Team name. Send to all running members of this team. Overrides targets."),
  tags: z.array(z.string()).optional()
    .describe("Filter targets by tags. Only instances with matching tags receive the message."),
  task_summary: z.string().optional().describe("Brief summary shown in logs"),
  request_kind: BroadcastRequestKind.optional().describe("Message intent"),
  requires_reply: z.boolean().optional().describe("Whether recipients should reply"),
});

// `correlation_id` is optional on both: omit it and one is minted, or pass the id
// from an inbound block to thread this request onto that conversation. It used to
// be absent from these two schemas, so zod stripped it and wrapAsSend's forwarding
// (which reads v.data.correlation_id) was dead for everything except report_result.
export const RequestInformationArgs = z.object({
  target_instance: NonEmptyString.describe("Name of the instance to ask."),
  question: NonEmptyString.describe("The question to ask."),
  context: z.string().optional().describe("Optional context to help the recipient answer."),
  correlation_id: z.string().optional()
    .describe("Optional: thread this onto an existing exchange (from an inbound block)."),
});

export const DelegateTaskArgs = z.object({
  target_instance: NonEmptyString.describe("Name of the instance to delegate to."),
  task: NonEmptyString.describe("Description of the task to perform."),
  forwards: ForwardMessageIds,
  steer: z.boolean().optional().describe(
    "Inject as a supplement into the target's CURRENT turn — for correcting or adding to work you just sent. Omit for a new task. Safe: an idle target receives it normally; an unsupported backend falls back to the idle queue.",
  ),
  success_criteria: z.string().optional()
    .describe("How the recipient should judge if the task is complete."),
  context: z.string().optional().describe("Optional background context for the task."),
  correlation_id: z.string().optional()
    .describe("Optional: thread this onto an existing exchange (from an inbound block)."),
});

export const ReportResultArgs = z.object({
  target_instance: NonEmptyString.describe("Name of the instance to report to."),
  correlation_id: z.string().optional()
    .describe("The correlation_id shown in the request's inbound block."),
  summary: NonEmptyString.describe("Summary of the result."),
  artifacts: z.string().optional()
    .describe("Optional details: file paths, commit hashes, URLs, etc."),
});

// Read-only lookup of a previously accepted durable operation. Exactly one
// selector is required; caller identity comes from the authenticated socket,
// never from these arguments.
export const DeliveryStatusArgs = z.object({
  delivery_id: NonEmptyString.optional().describe("Exact durable delivery ID returned by AgEnD."),
  operation_id: NonEmptyString.optional().describe("Operation ID returned when the outbound tool was accepted."),
  correlation_id: NonEmptyString.optional().describe("Correlation ID from the original request; may return multiple deliveries."),
  message_id: NonEmptyString.optional().describe("The message_id in an inbound message's header. Verify it before acting: 'Delivery not found' may mean hidden by ACL, expired retention, or never delivered. Do not act; ask the sender to explicitly forward a verifiable reference. Never resend on uncertain."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum rows for operation/correlation queries (default 20, maximum 100)."),
  cursor: NonEmptyString.optional().describe("Opaque next-page cursor returned by the previous query."),
}).strict().refine(args =>
  [args.delivery_id, args.operation_id, args.correlation_id, args.message_id].filter(value => value !== undefined).length === 1,
{ message: "Provide exactly one of delivery_id, operation_id, correlation_id, or message_id" })
  .refine(args => !args.cursor || !args.delivery_id, {
    message: "cursor is only valid with operation_id, correlation_id or message_id",
    path: ["cursor"],
  });

// ── Teams ───────────────────────────────────────────────────────────────

export const CreateTeamArgs = z.object({
  name: NonEmptyString.describe("Team name (e.g. 'sprint-1', 'reviewers')"),
  members: z.array(z.string()).describe("Instance names to include"),
  description: z.string().optional()
    .describe("Optional description of the team's purpose"),
});

export const DeleteTeamArgs = z.object({
  name: NonEmptyString.describe("Team name to delete"),
});

export const UpdateTeamArgs = z.object({
  name: NonEmptyString.describe("Team name"),
  add: z.array(z.string()).optional()
    .describe("Instance names to add (duplicates ignored)"),
  remove: z.array(z.string()).optional()
    .describe("Instance names to remove"),
  description: z.string().max(2000).optional()
    .describe("New description of the team's purpose; an empty string clears it. A team cannot be renamed."),
});

export const ListTeamsArgs = z.object({});

// ── Fleet Templates ─────────────────────────────────────────────────────

export const DeployTemplateArgs = z.object({
  template: NonEmptyString.describe("Template name from fleet.yaml templates section."),
  directory: NonEmptyString.describe(
    "Working directory (shared by all instances, or base repo for worktrees).",
  ),
  name: z.string().optional().describe(
    "Deployment name (used as team name and instance name prefix). Defaults to template name.",
  ),
  branch: z.string().optional().describe(
    "Git branch — each instance gets its own worktree branched from this.",
  ),
});

export const TeardownDeploymentArgs = z.object({
  name: NonEmptyString.describe("Deployment name (as used in deploy_template)."),
});

export const ListDeploymentsArgs = z.object({});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Validate raw args with a zod schema. Returns a tagged result so callers can
 * propagate a clean error message to the agent without leaking internals.
 */
export function validateArgs<T>(
  schema: z.ZodType<T>,
  args: unknown,
  toolName: string,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid args for ${toolName}: ${detail}` };
}

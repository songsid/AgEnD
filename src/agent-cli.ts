#!/usr/bin/env node
/**
 * agend-agent — thin CLI client for agent fleet operations.
 * Sends JSON POST to the daemon's /agent endpoint and prints JSON result.
 *
 * Usage: agend-agent <op> [args...]
 * Env:   AGEND_PORT (default 19280), AGEND_INSTANCE_NAME (required),
 *        AGEND_HOME (default ~/.agend)
 */
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { splitFlags } from "./cli-flags.js";
import { agentTokenHeader } from "./agent-token-header.js";
import { readAgentFile } from "./agent-file-read.js";
import { sendTaskWrite, wantsAttach } from "./task-attach-client.js";
import { listBundledSkills, readBundledSkill } from "./bundled-skills.js";
import { ASSET_UPLOAD_MAX_BYTES, receivePreview, sendAssetInParts, THEME_ASSET_SLOTS, writePreview } from "./web-asset-parts.js";

const PORT = parseInt(process.env.AGEND_PORT ?? "19280", 10);
const INSTANCE = process.env.AGEND_INSTANCE_NAME ?? "";
const DATA_DIR = process.env.AGEND_HOME || join(homedir(), ".agend");

function readInstanceToken(): string | null {
  if (!INSTANCE) return null;
  try {
    return readFileSync(join(DATA_DIR, "instances", INSTANCE, "agent.token"), "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * #1629: `theme set` pairs → the patch's `set`: dotted keys nest, numbers where the schema has numbers
 * (bubble.radius, background.opacity), everything else as written (the fleet checks every value).
 */
const NUMERIC_THEME_KEYS = new Set(["bubble.radius", "background.opacity"]);
function themeSetPairs(pairs: string[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) die(`theme set: "${pair}" is not key=value`);
    const key = pair.slice(0, at), raw = pair.slice(at + 1);
    const parts = key.split(".");
    if (parts.some(p => !/^[a-zA-Z0-9]+$/.test(p))) die(`theme set: "${key}" is not a theme key`);
    let node = set;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = NUMERIC_THEME_KEYS.has(key) && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return set;
}

function post(op: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ instance: INSTANCE, op, args });
    const token = readInstanceToken();
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    // Include the instance name in the header so the endpoint can verify the
    // token before reading the body (security fix, #1489). The instance name
    // is percent-encoded so non-ASCII names (e.g. "遊戲開發-opus-…") and names
    // containing ":" survive HTTP header transmission.
    if (token) headers["X-Agend-Instance-Token"] = agentTokenHeader(INSTANCE, token);
    const req = request({
      hostname: "127.0.0.1",
      port: PORT,
      path: "/agent",
      method: "POST",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function die(msg: string): never {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

/**
 * `agend-agent task …`: the `task` tool's actions and fields, as commands — the same arguments, so the fleet judges
 * them by the same rules as a tool call (who may edit a card, `version` conflicts, one card in progress, unsupported fields refused
 * by name: task-board-tool.ts). Every field the tool has is a flag here, from ONE table, so a field cannot be left out for want of
 * a switch case; what an action may take is the fleet's to say (ACTION_FIELDS), not repeated here.
 *
 * A flag takes its value as the next word or as `--flag=value`; `--` ends the flags (a title or comment that starts with `--name`).
 * Words that are not flags keep the positions they always had (`create "title" [description] [priority] [assignee]`, …).
 */
const TASK_TEXT_FLAGS: Readonly<Record<string, string>> = {
  "--title": "title", "--description": "description", "--priority": "priority", "--assignee": "assignee", "--project": "project",
  "--parent": "parent", "--scope": "scope", "--context": "context", "--size": "size", "--dispatcher": "dispatcher", "--status": "status",
  "--result": "result", "--state": "state", "--log": "log", "--comment": "comment", "--reason": "reason", "--watcher": "watcher",
  "--name": "name", "--filter-assignee": "filter_assignee", "--cursor": "cursor",
  // Comment threads: the comment you answer / change (its number is the c12 `task get --detail` shows beside it; c, # and digits are all read).
  "--reply-to": "reply_to", "--comment-id": "comment_id",
};
/** Repeatable: every occurrence is one more entry (`--acceptance` one checklist item each; `--depends-on` also takes a comma list). */
// `--attach FILE`: a file on your side to put on the card with the comment of this write; read here, never by the fleet.
const TASK_LIST_FLAGS: Readonly<Record<string, string>> = { "--acceptance": "acceptance", "--depends-on": "depends_on", "--attach": "attach" };
const TASK_INT_FLAGS: Readonly<Record<string, string>> = { "--version": "version", "--limit": "limit" };
/** Repeatable whole numbers, comma lists too (`--check 1,3 --check 4`). */
const TASK_INTS_FLAGS: Readonly<Record<string, string>> = { "--check": "check", "--uncheck": "uncheck" };
const TASK_BOOL_FLAGS: Readonly<Record<string, [string, boolean]>> = {
  "--detail": ["detail", true], "--verbose": ["verbose", true], "--stale": ["stale", true],
  "--needs-review": ["needs_review", true], "--no-needs-review": ["needs_review", false],
};
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];

function taskWords(words: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [], flags: Record<string, unknown> = {};
  const whole = (flag: string, text: string): number => { if (!/^-?\d+$/.test(text.trim())) die(`${flag} takes a whole number, got "${text}"`); return Number(text); };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") { positional.push(...words.slice(i + 1)); break; }
    // Only a word shaped like an option is one (`--name`, `--name=value`): a text that has always been a positional (`---`, `-- note`,
    // `--Draft v2`) stays one. A word of that shape that is no option is a mistake, said at once, before any request.
    if (!/^--[a-z][a-z0-9-]*(=|$)/.test(word)) { positional.push(word); continue; }
    const eq = word.indexOf("="), flag = eq > 0 ? word.slice(0, eq) : word;
    if (Object.hasOwn(TASK_BOOL_FLAGS, flag)) {
      if (eq > 0) die(`${flag} takes no value`);
      const [key, value] = TASK_BOOL_FLAGS[flag]!; flags[key] = value; continue;
    }
    const text = Object.hasOwn(TASK_TEXT_FLAGS, flag), list = Object.hasOwn(TASK_LIST_FLAGS, flag), int = Object.hasOwn(TASK_INT_FLAGS, flag), ints = Object.hasOwn(TASK_INTS_FLAGS, flag);
    if (!text && !list && !int && !ints) die(`Unknown task option: ${flag} (a text that starts with -- goes after a lone --)`);
    let value: string | undefined;
    if (eq > 0) value = word.slice(eq + 1);
    else { value = words[++i]; if (value === undefined) die(`Missing value for ${flag}`); }
    if (text) flags[TASK_TEXT_FLAGS[flag]!] = value;
    else if (list) {
      const key = TASK_LIST_FLAGS[flag]!;
      ((flags[key] ??= []) as string[]).push(...(flag === "--depends-on" ? value.split(",").map(x => x.trim()).filter(Boolean) : [value]));
    } else if (int) flags[TASK_INT_FLAGS[flag]!] = whole(flag, value);
    else {
      const key = TASK_INTS_FLAGS[flag]!;
      ((flags[key] ??= []) as number[]).push(...value.split(",").map(x => whole(flag, x)));
    }
  }
  if (typeof flags.priority === "string" && !TASK_PRIORITIES.includes(flags.priority)) die(`--priority is one of ${TASK_PRIORITIES.join(", ")}`);
  if (typeof flags.size === "string") {
    flags.size = flags.size.toUpperCase();
    if (!["S", "M", "L"].includes(flags.size as string)) die("--size is S, M or L");
  }
  return { positional, flags };
}

function taskArgs(words: string[]): Record<string, unknown> {
  const { positional: rest, flags } = taskWords(words);
  // `create-project` / `move-project` are the tool's create_project / move_project.
  const action = rest[0]?.replaceAll("-", "_");
  let args: Record<string, unknown>;
  switch (action) {
    case "create": args = { action, title: rest[1] ?? "", description: rest[2], priority: rest[3], assignee: rest[4] }; break;
    case "list": {
      // list [filter_assignee] [filter_status[,filter_status…]] [verbose]; --project, --parent, --stale, --detail, --limit, --cursor
      // e.g. `task list "" "done,cancelled"` or `task list "" "" true`
      const rawStatus = rest[2];
      const statusArg = rawStatus
        ? rawStatus.includes(",") ? rawStatus.split(",").map(s => s.trim()).filter(Boolean)
          : rawStatus.trim() || undefined
        : undefined;
      args = { action, filter_assignee: rest[1] || undefined, filter_status: statusArg, verbose: rest[3] === "true" || undefined };
      break;
    }
    case "get": case "claim": args = { action, id: rest[1] ?? "" }; break;
    case "done": args = { action, id: rest[1] ?? "", result: rest[2] }; break;
    // update ID [STATUS [priority]] plus any field as a flag (--title, --log, --comment, --check 1, --version 4, …).
    case "update": args = { action, id: rest[1] ?? "", status: rest[2], priority: rest[3] }; break;
    // The task board (step 2): your work, a move with its reason or result, a comment, the projects.
    case "mine": case "projects": args = { action }; break;
    // move ID STATUS ["text"]: the text is the result for review/done, the reason otherwise (blocked, cancelled…).
    case "move": {
      const finishing = rest[2] === "review" || rest[2] === "done";
      args = { action, id: rest[1] ?? "", to: rest[2], ...(finishing ? { result: rest[3] } : { reason: rest[3] }) };
      break;
    }
    case "comment": args = { action: "update", id: rest[1] ?? "", comment: rest[2] }; break;
    // edit-comment ID COMMENT_ID "new words": change a comment of your own (COMMENT_ID is the c12 `get --detail` shows).
    case "edit_comment": args = { action, id: rest[1] ?? "", comment_id: rest[2], comment: rest[3] }; break;
    // attach ID FILE [FILE…] [--comment TXT]: files from your working directory, on the card under a comment.
    case "attach": args = { action, id: rest[1] ?? "", attach: rest.slice(2) }; break;
    case "create_project": args = { action, name: rest[1], description: rest[2] }; break;
    // move-project PROJECT ID [ID…]: PROJECT is a project's id (what `projects` lists) or `none`.
    case "move_project": args = { action, project: rest[1], ids: rest.slice(2) }; break;
    // watch ID [WATCHER]: you by default; another instance only on a card you may edit.
    case "watch": case "unwatch": args = { action, id: rest[1] ?? "", watcher: rest[2] }; break;
    default: args = { action: rest[0] ?? "" }; break;
  }
  // A flag is the field named: it wins over the word in that position, and anything the action does not take is refused by the fleet by name.
  return Object.assign(args, flags);
}

async function main(): Promise<void> {
  const [,, first, ...given] = process.argv;
  if (!first) die("Usage: agend-agent <op> [args...]");
  // #1629: `theme <get|set|clear|asset|reset> …` is sent as its own op each (theme-get, …): one op, one tool.
  // #1629 r4 §1: `appearance` (get) and `appearance preview [light|dark]`.
  // r4-4: `widget set|data <slot> …` and `widget remove [slot]` (data is set_web_widget with values only).
  // #2117: `ambient set '<json spec>'` and `ambient clear [loop|click]`.
  // #2578: `office view [office]` and `office set '<json>'` (office_set's arguments).
  // #2692: `office packs|pack-check|pack-upload|pack-delete|pack-restore|style …` (the skin packs).
  const op = first === "theme" ? `theme-${given[0] ?? ""}` : first === "appearance" ? (given[0] === "preview" ? "appearance-preview" : given.length ? `appearance-${given[0]}` : "appearance-get")
    : first === "effect" ? `effect-${given[0] ?? ""}` : first === "widget" ? (given[0] === "data" ? "widget-set" : `widget-${given[0] ?? ""}`)
    : first === "mod" ? `mod-${given[0] ?? ""}` : first === "ambient" ? `ambient-${given[0] ?? ""}` : first === "office" ? `office-${given[0] ?? "view"}` : first;
  const rest = first === "theme" || first === "widget" || first === "effect" || first === "mod" || first === "ambient" || first === "office" || (first === "appearance" && given.length) ? given.slice(1) : given;
  const widgetData = first === "widget" && given[0] === "data";
  // #2163: `skill [name]` reads a skill AgEnD ships, locally (no fleet, no instance needed): the list, or one whole.
  if (first === "skill") {
    if (!given[0]) { for (const s of listBundledSkills()) console.log(`${s.name}\t${s.description}`); return; }
    const r = readBundledSkill(given[0]);
    if (!r.ok) die(r.error);
    process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
    return;
  }
  if (!INSTANCE) die("AGEND_INSTANCE_NAME not set");

  const listRead = ["schedule-list", "decision-list", "decision-get"].includes(op);   // `task` has its own flags (taskArgs)
  const listFlags: Record<string, unknown> = {};
  if (listRead) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--detail") { listFlags.detail = true; rest.splice(i--, 1); }
      else if (rest[i] === "--limit" || rest[i] === "--cursor") {
        const key = rest[i]!.slice(2), value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) die(`Missing value for --${key}`);
        listFlags[key] = key === "limit" ? Number(value) : value;
        rest.splice(i, 2); i--;
      } else if (rest[i]?.startsWith("--")) die(`Unknown list option: ${rest[i]}`);
    }
  }
  let args: Record<string, unknown> = {};

  switch (op) {
    // Channel
    case "reply": {
      // --sticker <id> (repeatable, up to 3; #1226) may come anywhere; the rest is <text> [files…].
      const { flags, positional } = splitFlags(rest, ["--sticker", "--previews"]);
      const stickers = flags["--sticker"] ?? [];
      let previews;
      if (flags["--previews"]) {
        try { previews = JSON.parse(flags["--previews"].at(-1)!); } catch { previews = null; }
        if (!Array.isArray(previews)) throw new Error("--previews must be a JSON array of relative paths and valid line ranges");
      }
      args = {
        text: positional[0] ?? "",
        ...(positional.length > 1 ? { files: positional.slice(1) } : {}),
        ...(stickers.length ? { stickers } : {}),
        ...(previews ? { previews } : {}),
      };
      break;
    }
    case "react": args = { emoji: rest[0] ?? "", message_id: rest[1] }; break;
    case "edit": args = { message_id: rest[0], text: rest[1] ?? "" }; break;
    case "download": args = { file_id: rest[0] ?? "" }; break;

    // Communication
    case "send":
    case "delegate": {
      const { flags, positional } = splitFlags(rest, ["--forward"], ["--detail"]);
      args = op === "send"
        ? { instance_name: positional[0], message: positional[1] ?? "", request_kind: positional[2] }
        : { target_instance: positional[0], task: positional[1] ?? "", success_criteria: positional[2], context: positional[3] };
      if (flags["--forward"]) args.forwards = flags["--forward"];
      if (flags["--detail"]) args.detail = true;
      break;
    }
    case "report": {
      const { flags, positional } = splitFlags(rest, [], ["--detail"]);
      args = { target_instance: positional[0], summary: positional[1] ?? "", correlation_id: positional[2], artifacts: positional[3], ...(flags["--detail"] ? { detail: true } : {}) };
      break;
    }
    case "ask": {
      const { flags, positional } = splitFlags(rest, [], ["--detail"]);
      args = { target_instance: positional[0], question: positional[1] ?? "", context: positional[2], ...(flags["--detail"] ? { detail: true } : {}) };
      break;
    }
    case "delivery-status": {
      for (let i = 0; i < rest.length; i++) {
        const key = rest[i]!.replace(/^--/, "").replaceAll("-", "_");
        if (key === "detail") { args.detail = true; continue; }
        if (!["delivery_id", "operation_id", "correlation_id", "message_id", "limit", "cursor", "content_includes"].includes(key)) {
          die(`Unknown delivery-status option: ${rest[i]}`);
        }
        const value = rest[++i];
        if (value === undefined) die(`Missing value for --${key.replaceAll("_", "-")}`);
        args[key] = key === "limit" ? Number(value) : value;
      }
      break;
    }
    case "broadcast": {
      const { flags, positional } = splitFlags(rest, [], ["--detail"]);
      args = { message: positional[0] ?? "", team: positional[1], ...(flags["--detail"] ? { detail: true } : {}) };
      break;
    }

    // Usage
    case "usage": {
      const { flags, positional } = splitFlags(rest, [], ["--force", "--detail"]);
      if (positional.length) die(`Unknown usage option: ${positional[0]}`);
      args = { ...(flags["--force"] ? { force: true } : {}), ...(flags["--detail"] ? { detail: true } : {}) };
      break;
    }

    // Instance management
    case "list": break;
    case "describe": args = { name: rest[0] ?? "" }; break;
    case "start": args = { name: rest[0] ?? "" }; break;
    case "spawn": args = { directory: rest[0], topic_name: rest[1], backend: rest[2] }; break;
    case "delete": args = { name: rest[0] ?? "" }; break;
    case "replace": args = { name: rest[0] ?? "", reason: rest[1] }; break;
    case "rename": args = { name: rest[0] ?? "" }; break;
    case "set-description": args = { description: rest[0] ?? "" }; break;
    case "emojis": {
      const { flags } = splitFlags(rest, ["--name", "--limit"], ["--refresh", "--primary", "--urls"]);
      args = {
        ...(flags["--refresh"] ? { refresh: true } : {}),
        ...(flags["--name"]?.[0] ? { name: flags["--name"][0] } : {}),
        ...(flags["--limit"]?.[0] ? { limit: Number(flags["--limit"][0]) } : {}),
        ...(flags["--primary"] ? { primary_only: true } : {}),
        ...(flags["--urls"] ? { with_image_urls: true } : {}),
      };
      break;
    }
    case "stickers": {
      const { flags, positional } = splitFlags(rest, ["--name", "--limit"], ["--refresh"]);
      args = {
        ...(positional[0] ? { set: positional[0] } : {}),
        ...(flags["--refresh"] ? { refresh: true } : {}),
        ...(flags["--name"]?.[0] ? { name: flags["--name"][0] } : {}),
        ...(flags["--limit"]?.[0] ? { limit: Number(flags["--limit"][0]) } : {}),
      };
      break;
    }
    case "sticker-preview":
      if (rest.length === 0) die("Usage: agend-agent sticker-preview <sticker id> [more…]");
      args = { stickers: rest };
      break;
    case "persona-emoji":
      // No argument is a mistake, not a request to clear: that takes an explicit "".
      if (rest[0] === undefined) die('Usage: agend-agent persona-emoji <emoji | ""> [status]');
      args = { emoji: rest[0], ...(rest[1] ? { status: rest[1] } : {}) };
      break;
    case "emoji-preview":
      if (rest.length === 0) die("Usage: agend-agent emoji-preview <:name:id> [more…]");
      args = { emojis: rest };
      break;

    // #1629: your own web theme.
    case "theme-get":
      break;
    case "theme-set":
      if (rest[0] === "--json") {
        if (!rest[1]) die("Usage: agend-agent theme set --json '<patch>'");
        let patch: unknown;
        try { patch = JSON.parse(rest[1]); } catch { die("theme set --json: not JSON"); }
        const p = patch as Record<string, unknown>;
        args = p && typeof p === "object" && (Object.hasOwn(p, "set") || Object.hasOwn(p, "clear")) ? p : { set: p };
      } else {
        if (rest.length === 0) die('Usage: agend-agent theme set key=value [key=value…]   e.g. colors.dark.accent=#7c3aed bubble.radius=12 workingLabel="Thinking"');
        args = { set: themeSetPairs(rest) };
      }
      break;
    case "theme-clear":
      if (rest.length === 0) die("Usage: agend-agent theme clear <dotted.path> [more…]   e.g. colors.dark.bg");
      args = { clear: rest };
      break;
    case "theme-asset": {
      if (!(THEME_ASSET_SLOTS as readonly string[]).includes(rest[0] ?? "") || !rest[1]) die(`Usage: agend-agent theme asset <${THEME_ASSET_SLOTS.join("|")}> <file>`);
      // Read here, on the agent's side, in its working directory: the fleet never opens a workspace path. A picture
      // larger than one request body goes up in parts (r4 §1); the fleet checks the slot's limit in force.
      const read = await readAgentFile(rest[1], { workspace: process.cwd(), stateDir: DATA_DIR, instance: INSTANCE, maxBytes: ASSET_UPLOAD_MAX_BYTES });
      if (!read.ok) die(`theme asset: ${rest[1]} — ${read.reason}`);
      try {
        const answer = await sendAssetInParts(rest[0], read.bytes, async (part) => {
          const text = await post(op, part);
          try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; }
        });
        console.log(JSON.stringify(answer));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }
    case "theme-reset":
      break;
    case "appearance-get":
      break;
    case "widget-set": {
      const usage = widgetData ? "Usage: agend-agent widget data <chat_header|details> '<json values>'" : "Usage: agend-agent widget set <chat_header|details> '<json spec>' ['<json data>']";
      const json = (text: string | undefined, what: string): Record<string, unknown> => {
        if (!text) die(usage);
        let v: unknown;
        try { v = JSON.parse(text); } catch { die(`widget: ${what} is not JSON`); }
        if (!v || typeof v !== "object" || Array.isArray(v)) die(`widget: ${what} must be a JSON object`);
        return v as Record<string, unknown>;
      };
      if (!rest[0]) die(usage);
      args = widgetData ? { slot: rest[0], data: json(rest[1], "data") } : { slot: rest[0], spec: json(rest[1], "spec"), ...(rest[2] !== undefined ? { data: json(rest[2], "data") } : {}) };
      break;
    }
    case "widget-remove":
      args = rest[0] ? { slot: rest[0] } : {};
      break;
    case "ambient-set": {
      let v: unknown;
      if (!rest[0]) die("Usage: agend-agent ambient set '<json spec>'");
      try { v = JSON.parse(rest[0]); } catch { die("ambient: the spec is not JSON"); }
      if (!v || typeof v !== "object" || Array.isArray(v)) die("ambient: the spec must be a JSON object");
      args = v as Record<string, unknown>;
      break;
    }
    case "office-view":
      args = rest[0] ? { office: rest[0] } : {};
      break;
    case "office-set": {
      let v: unknown;
      if (!rest[0]) die("Usage: agend-agent office set '<json>'   e.g. '{\"go\":{\"seat\":\"desks:0\"},\"say\":\"On it\"}'");
      try { v = JSON.parse(rest[0]); } catch { die("office: the arguments are not JSON"); }
      if (!v || typeof v !== "object" || Array.isArray(v)) die("office: the arguments must be a JSON object");
      args = v as Record<string, unknown>;
      break;
    }
    // #2692: the skin packs. `office packs`, `office pack-check|pack-upload <dir> [<dir>…] [--drop-invalid-overrides]`
    // (read here, in this working directory or the fleet's shared folder; the bytes go up in parts),
    // `office pack-delete <id> [--keep-previous]`, `office pack-restore <id> [--drop-invalid-overrides]`, `office style <office> <pack>`.
    case "office-packs":
      if (rest.length) die("Usage: agend-agent office packs");
      break;
    case "office-pack-check": case "office-pack-upload": {
      const drop = rest.includes("--drop-invalid-overrides"), dirs = rest.filter(a => a !== "--drop-invalid-overrides");
      if (!dirs.length || dirs.some(d => d.startsWith("--"))) die(`Usage: agend-agent office ${op.slice(7)} <pack folder> [more folders…] [--drop-invalid-overrides]`);
      const { sendPackSources } = await import("./web-office-pack-read.js");
      try {
        const answer = await sendPackSources({ ...(dirs.length === 1 ? { dir: dirs[0] } : { packs: dirs.map(dir => ({ dir })) }), ...(drop ? { drop_invalid_overrides: true } : {}) },
          { workspace: process.cwd(), stateDir: DATA_DIR, instance: INSTANCE }, async payload => {
            const text = await post(op, payload);
            try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; }
          });
        console.log(JSON.stringify(answer));
        if (typeof answer.error === "string") process.exit(1);
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }
    case "office-pack-delete":
      if (!rest[0] || rest.slice(1).some(a => a !== "--keep-previous")) die("Usage: agend-agent office pack-delete <id> [--keep-previous]");
      args = { id: rest[0], ...(rest.includes("--keep-previous") ? { keep_previous: true } : {}) };
      break;
    case "office-pack-restore":
      if (!rest[0] || rest.slice(1).some(a => a !== "--drop-invalid-overrides")) die("Usage: agend-agent office pack-restore <id> [--drop-invalid-overrides]");
      args = { id: rest[0], ...(rest.includes("--drop-invalid-overrides") ? { drop_invalid_overrides: true } : {}) };
      break;
    case "office-style":
      if (rest.length !== 2) die("Usage: agend-agent office style <office id> <pack id or built-in style>");
      args = { office: rest[0], pack: rest[1] };
      break;
    case "ambient-clear":
      args = rest[0] ? { which: rest[0] } : {};
      break;
    // #2799: the removed Canvas Worker ops are still sent, so the fleet answers them plainly (as while they were off).
    case "effect-upload": case "effect-list": case "effect-preview": case "effect-profile": case "effect-apply":
    case "effect-remove": case "effect-delete": case "mod-export": case "mod-propose": break;
    case "appearance-preview": {
      if (rest.some(m => m !== "light" && m !== "dark")) die("Usage: agend-agent appearance preview [light|dark]");
      // The fleet sends the SVGs (whole, or in parts); they are written here, in this working directory.
      const ask = async (a: Record<string, unknown>) => { const text = await post(op, a); try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; } };
      try {
        const got = await receivePreview(await ask(rest.length ? { modes: rest } : {}), ask);
        if ("error" in got) { console.log(JSON.stringify(got)); process.exit(1); }
        const written = await writePreview(got.files, { workspace: process.cwd(), stateDir: DATA_DIR, instance: INSTANCE });
        if ("error" in written) die(`appearance preview: ${written.error}`);
        console.log(JSON.stringify(written));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }

    // Task board
    case "task": args = taskArgs(rest); break;

    // Decisions
    // scope: project | team | team:<name> | fleet (omitted: your team when you are in one, else project).
    case "decision-post": {
      const [scope, team] = rest[2]?.startsWith("team:") ? ["team", rest[2].slice(5)] : [rest[2], undefined];
      args = { title: rest[0] ?? "", content: rest[1] ?? "", scope, ...(team ? { team } : {}), tags: rest[3] }; break;
    }
    case "decision-list": args = { include_archived: rest[0] === "true" }; break;
    case "decision-get": args = { id: rest[0] ?? "" }; break;
    case "decision-update": args = { id: rest[0] ?? "", content: rest[1], archive: rest[2] === "true" }; break;

    // Schedules
    case "schedule-create": args = { cron: rest[0] ?? "", message: rest[1] ?? "", target: rest[2], label: rest[3] }; break;
    case "schedule-list": args = { target: rest[0] }; break;
    case "schedule-update": args = { id: rest[0] ?? "", cron: rest[1], message: rest[2], enabled: rest[3] }; break;
    case "schedule-delete": args = { id: rest[0] ?? "" }; break;

    // Teams
    case "team-create": args = { name: rest[0] ?? "", members: rest.slice(1) }; break;
    case "team-list": break;
    case "team-delete": args = { name: rest[0] ?? "" }; break;
    case "team-update": {
      // team-update <name> [add,…] [remove,…] [description] — the lists comma-separated ("" for none); a description of
      // "" clears it, none leaves it (#1689: update_team takes lists, so a bare string was refused before).
      const list = (s?: string) => (s ? s.split(",").map(x => x.trim()).filter(Boolean) : undefined);
      args = { name: rest[0] ?? "", add: list(rest[1]), remove: list(rest[2]), ...(rest[3] !== undefined ? { description: rest[3] } : {}) };
      break;
    }

    // Deployments
    case "deploy": args = { template: rest[0] ?? "", directory: rest[1] ?? "", name: rest[2], branch: rest[3] }; break;
    case "teardown": args = { name: rest[0] ?? "" }; break;
    case "deploy-list": break;

    default: die(`Unknown op: ${op}`);
  }

  Object.assign(args, listFlags);

  // Strip undefined values
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) delete args[k];
  }

  try {
    // files named by `attach` are read here and staged on the fleet first; the write then carries their ids.
    let result: string;
    if (op === "task" && wantsAttach(args)) {
      // The files are staged, the write sent with their ids, and the ones a refused write did not use given back (sendTaskWrite).
      let written = "";
      const sent = await sendTaskWrite(args, { workspace: process.cwd(), stateDir: DATA_DIR, instance: INSTANCE }, async (call) => {
        const last = await post("task", call);
        if (call.action !== "upload" && call.action !== "release") written = last;      // the write's own answer, as it always was printed
        try {
          const parsed = JSON.parse(last) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { error?: unknown }).error === "string") return { error: (parsed as { error: string }).error };
          return { result: parsed };
        } catch { return { error: last.slice(0, 200) }; }
      });
      if (sent.staging) die(sent.error);
      result = written;
    } else result = await post(op, args);
    // The task board answers in text (a card, your work): printed as text, not as one quoted JSON line.
    if (op === "task") {
      try {
        const parsed = JSON.parse(result) as unknown;
        if (typeof parsed === "string") { console.log(parsed); return; }
      } catch { /* fall through to raw */ }
    }
    console.log(result);
  } catch (err) {
    die(`Connection failed: ${(err as Error).message}`);
  }
}

main();

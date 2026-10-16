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
import { ASSET_UPLOAD_MAX_BYTES, MOD_FILE, MOD_MAX_PARTS, MOD_UPLOAD_MAX_BYTES, receiveFiles, receivePreview, sendAssetInParts, THEME_ASSET_SLOTS, writeModFile, writePreview } from "./web-asset-parts.js";

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
    // is percent-encoded so non-ASCII names (e.g. "鬥破開發-opus-…") and names
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

async function main(): Promise<void> {
  const [,, first, ...given] = process.argv;
  if (!first) die("Usage: agend-agent <op> [args...]");
  // #1629: `theme <get|set|clear|asset|reset> …` is sent as its own op each (theme-get, …): one op, one tool.
  // #1629 r4 §1: `appearance` (get) and `appearance preview [light|dark]`.
  // r4-4: `widget set|data <slot> …` and `widget remove [slot]` (data is set_web_widget with values only).
  const op = first === "theme" ? `theme-${given[0] ?? ""}` : first === "appearance" ? (given[0] === "preview" ? "appearance-preview" : given.length ? `appearance-${given[0]}` : "appearance-get")
    : first === "effect" ? `effect-${given[0] ?? ""}` : first === "widget" ? (given[0] === "data" ? "widget-set" : `widget-${given[0] ?? ""}`)
    : first === "mod" ? `mod-${given[0] ?? ""}` : first;
  const rest = first === "theme" || first === "widget" || first === "effect" || first === "mod" || (first === "appearance" && given.length) ? given.slice(1) : given;
  const widgetData = first === "widget" && given[0] === "data";
  if (!INSTANCE) die("AGEND_INSTANCE_NAME not set");

  let args: Record<string, unknown> = {};

  switch (op) {
    // Channel
    case "reply": {
      // --sticker <id> (repeatable, up to 3; #1226) may come anywhere; the rest is <text> [files…].
      const { flags, positional } = splitFlags(rest, ["--sticker"]);
      const stickers = flags["--sticker"] ?? [];
      args = {
        text: positional[0] ?? "",
        ...(positional.length > 1 ? { files: positional.slice(1) } : {}),
        ...(stickers.length ? { stickers } : {}),
      };
      break;
    }
    case "react": args = { emoji: rest[0] ?? "", message_id: rest[1] }; break;
    case "edit": args = { message_id: rest[0], text: rest[1] ?? "" }; break;
    case "download": args = { file_id: rest[0] ?? "" }; break;

    // Communication
    case "send":
    case "delegate": {
      const { flags, positional } = splitFlags(rest, ["--forward"]);
      args = op === "send"
        ? { instance_name: positional[0], message: positional[1] ?? "", request_kind: positional[2] }
        : { target_instance: positional[0], task: positional[1] ?? "", success_criteria: positional[2], context: positional[3] };
      if (flags["--forward"]) args.forwards = flags["--forward"];
      break;
    }
    case "report": args = { target_instance: rest[0], summary: rest[1] ?? "", correlation_id: rest[2], artifacts: rest[3] }; break;
    case "ask": args = { target_instance: rest[0], question: rest[1] ?? "", context: rest[2] }; break;
    case "delivery-status": {
      for (let i = 0; i < rest.length; i++) {
        const key = rest[i]!.replace(/^--/, "").replaceAll("-", "_");
        if (!["delivery_id", "operation_id", "correlation_id", "message_id", "limit", "cursor"].includes(key)) {
          die(`Unknown delivery-status option: ${rest[i]}`);
        }
        const value = rest[++i];
        if (value === undefined) die(`Missing value for --${key.replaceAll("_", "-")}`);
        args[key] = key === "limit" ? Number(value) : value;
      }
      break;
    }
    case "broadcast": args = { message: rest[0] ?? "", team: rest[1] }; break;

    // Usage
    case "usage": args = { ...(rest[0] === "--force" ? { force: true } : {}) }; break;

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
      const read = await readAgentFile(rest[1], { workspace: process.cwd(), stateDir: DATA_DIR, maxBytes: ASSET_UPLOAD_MAX_BYTES });
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
    case "effect-upload": {
      const { readAgentEffect, sendEffectInParts } = await import("./web-effect-upload.js");
      if (rest.length !== 1) die("Usage: agend-agent effect upload <directory>");
      const read = await readAgentEffect(rest[0], { workspace: process.cwd(), stateDir: DATA_DIR });
      if (!read.ok) die(`effect upload: ${read.reason}`);
      try {
        const answer = await sendEffectInParts(read.files, async payload => {
          const text = await post(op, payload);
          try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error:"answer", message:text.slice(0,200) }; }
        });
        console.log(JSON.stringify(answer));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }
    case "effect-list":
      if (rest.length) die("Usage: agend-agent effect list");
      break;
    case "effect-preview": case "effect-profile": case "effect-delete":
      if (rest.length !== 1 || !/^[0-9a-f]{32}$/.test(rest[0]!)) die(`Usage: agend-agent ${op.replace("-"," ")} <id>`);
      args={id:rest[0]};break;
    case "effect-remove":
      if (rest.length > 1 || rest[0] !== undefined && !/^[0-9a-f]{32}$/.test(rest[0])) die("Usage: agend-agent effect remove [id]");
      args=rest[0]===undefined?{}:{id:rest[0]};break;
    case "effect-apply": {
      if (rest.length < 1 || rest.length > 2 || !/^[0-9a-f]{32}$/.test(rest[0]!)) die("Usage: agend-agent effect apply <id> ['<params JSON>']");
      let params: unknown;
      if (rest[1] !== undefined) {
        try { params=JSON.parse(rest[1]); } catch { die("effect apply: params is not JSON"); }
        if (!params || typeof params !== "object" || Array.isArray(params)) die("effect apply: params must be an object");
      }
      args={id:rest[0],...(params!==undefined?{params}:{})};break;
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
    // #1629 r4-5b: `mod export <name> <version> [title]` (written to .agend/mods/ here) and `mod propose <file>`.
    case "mod-export": {
      if (!rest[0] || !rest[1]) die("Usage: agend-agent mod export <name> <version> [title]");
      const ask = async (a: Record<string, unknown>) => { const text = await post(op, a); try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; } };
      try {
        const first = await ask({ name: rest[0], version: rest[1], ...(rest[2] ? { title: rest.slice(2).join(" ") } : {}) });
        const got = await receiveFiles(first, ask, { name: MOD_FILE, idKey: "transfer", what: "export", maxParts: MOD_MAX_PARTS });
        if ("error" in got) { console.log(JSON.stringify(got)); process.exit(1); }
        const written = await writeModFile(got.files, { workspace: process.cwd(), stateDir: DATA_DIR });
        if ("error" in written) die(`mod export: ${written.error}`);
        console.log(JSON.stringify({ ...written, ...(first.effects_omitted ? { effects_omitted: first.effects_omitted } : {}) }));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }
    case "mod-propose": {
      if (!rest[0]) die("Usage: agend-agent mod propose <file>");
      const read = await readAgentFile(rest[0], { workspace: process.cwd(), stateDir: DATA_DIR, maxBytes: MOD_UPLOAD_MAX_BYTES });
      if (!read.ok) die(`mod propose: ${rest[0]} — ${read.reason}`);
      try {
        const answer = await sendAssetInParts("mod", read.bytes, async (part) => {
          const text = await post(op, part);
          try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; }
        });
        console.log(JSON.stringify(answer));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }
    case "appearance-preview": {
      if (rest.some(m => m !== "light" && m !== "dark")) die("Usage: agend-agent appearance preview [light|dark]");
      // The fleet sends the SVGs (whole, or in parts); they are written here, in this working directory.
      const ask = async (a: Record<string, unknown>) => { const text = await post(op, a); try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: "answer", message: text.slice(0, 200) }; } };
      try {
        const got = await receivePreview(await ask(rest.length ? { modes: rest } : {}), ask);
        if ("error" in got) { console.log(JSON.stringify(got)); process.exit(1); }
        const written = await writePreview(got.files, { workspace: process.cwd(), stateDir: DATA_DIR });
        if ("error" in written) die(`appearance preview: ${written.error}`);
        console.log(JSON.stringify(written));
      } catch (err) { die(`Connection failed: ${(err as Error).message}`); }
      return;
    }

    // Task board
    case "task": {
      const action = rest[0];
      switch (action) {
        case "create": args = { action, title: rest[1] ?? "", description: rest[2], priority: rest[3], assignee: rest[4] }; break;
        case "list": {
          // list [filter_assignee] [filter_status[,filter_status…]] [verbose]
          // e.g. `task list "" "done,cancelled"` or `task list "" "" true`
          const rawStatus = rest[2];
          const statusArg = rawStatus
            ? rawStatus.includes(",") ? rawStatus.split(",").map(s => s.trim()).filter(Boolean)
              : rawStatus.trim() || undefined
            : undefined;
          args = { action, filter_assignee: rest[1] || undefined, filter_status: statusArg, verbose: rest[3] === "true" || undefined };
          break;
        }
        case "get": args = { action, id: rest[1] ?? "" }; break;
        case "claim": args = { action, id: rest[1] ?? "" }; break;
        case "done": args = { action, id: rest[1] ?? "", result: rest[2] }; break;
        case "update": args = { action, id: rest[1] ?? "", status: rest[2], priority: rest[3] }; break;
        default: args = { action: action ?? "" }; break;
      }
      break;
    }

    // Decisions
    case "decision-post": args = { title: rest[0] ?? "", content: rest[1] ?? "", scope: rest[2], tags: rest[3] }; break;
    case "decision-list": args = { include_archived: rest[0] === "true" }; break;
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

  // Strip undefined values
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) delete args[k];
  }

  try {
    const result = await post(op, args);
    // `usage` responses carry a pre-rendered text block; print that instead of
    // one long JSON line so an agent (or a human) can read it directly.
    if (op === "usage") {
      try {
        const parsed = JSON.parse(result) as { formatted?: string; error?: string };
        console.log(parsed.error ? result : parsed.formatted ?? result);
        return;
      } catch { /* fall through to raw */ }
    }
    console.log(result);
  } catch (err) {
    die(`Connection failed: ${(err as Error).message}`);
  }
}

main();

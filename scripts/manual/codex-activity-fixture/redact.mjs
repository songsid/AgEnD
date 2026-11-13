#!/usr/bin/env node
// Redact a real Codex rollout into a test fixture for the chat's activity block (#3787).
//
//   node scripts/manual/codex-activity-fixture/redact.mjs <rollout.jsonl> <out.jsonl> <real-cwd>
//
// What is kept: only the record kinds the activity parser reads (plus `turn_context`, which names the turn, and `compacted`
// with a stub history). What is removed: the account and user ids of `session_meta`, the developer/system messages,
// token counts, world state, thread settings — everything the parser ignores. What is replaced: the working directory
// (`<real-cwd>` → /home/user/project), the OS user name, the time zone, the encrypted reasoning blob (a fixed placeholder
// of the same shape), the listing of the tools installed in that Codex (what `ALL_TOOLS` printed: it names the person's
// own connectors; only the stub `agend` tool stays), and every opaque id (turn, thread, call, message, response, process) by a numbered one, consistently within the file.
// Then the output is read for anything that still looks like a secret or a local path, and the script refuses to write
// it if something does.
import { readFileSync, writeFileSync } from "node:fs";

const [src, out, cwd] = process.argv.slice(2);
if (!src || !out || !cwd) { console.error("usage: redact.mjs <rollout.jsonl> <out.jsonl> <real-cwd>"); process.exit(2); }

const ids = new Map();
const idOf = (kind, raw) => { const k = `${kind}:${raw}`; if (!ids.has(k)) ids.set(k, ids.size + 1); return ids.get(k); };
const hex = (n, w) => n.toString(16).padStart(w, "0");
const uuid = (raw) => `01a1d350-${hex(idOf("uuid", raw), 4)}-7000-8000-${hex(idOf("uuid", raw), 12)}`;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const PREFIXED = /\b(resp|msg|rs|ctc|ctco|fco|call|fc)_([0-9A-Za-z]{8,})\b/g;

const user = (process.env.USER || "").trim();
const redactText = (t) => {
  let s = t.split(cwd).join("/home/user/project");
  if (user) s = s.split(`/home/${user}`).join("/home/user").split(user).join("user");
  return s.replace(/<timezone>[^<]*<\/timezone>/g, "<timezone>UTC</timezone>").replace(UUID, (m) => uuid(m)).replace(PREFIXED, (_m, p, rest) => `${p}_${String(idOf(p, rest)).padStart(6, "0")}`);
};

const KEEP_EVENT = new Set(["task_started", "task_complete", "turn_aborted", "error"]);
const KEEP_ITEM = new Set(["AgentMessage", "CommandExecution", "McpToolCall", "FileChange", "ContextCompaction", "Reasoning", "Extension", "ImageView"]);
const records = [];
// The recording's stub `agend` MCP server restarted with each `codex exec`, so a later run reused an earlier run's reply id
// (`web-stub1-…`); AgEnD's own ids are unique. A reply id that shows up in a later turn is renamed there.
let turnNo = 0;
const replyIn = new Map();
const uniqueReplyIds = (t) => t.replace(/web-stub[0-9a-z]+-[0-9a-f]+/g, (id) => {
  if (!replyIn.has(id)) replyIn.set(id, turnNo);
  return replyIn.get(id) === turnNo ? id : `${id}-t${turnNo}`;
});
for (const line of readFileSync(src, "utf8").split("\n")) {
  if (!line) continue;
  const e = JSON.parse(line);
  const p = e.payload ?? {};
  let keep = null;
  if (e.type === "session_meta") {
    keep = { id: p.id, timestamp: p.timestamp, cwd: p.cwd, originator: p.originator, cli_version: p.cli_version, source: p.source, model_provider: p.model_provider };
  } else if (e.type === "turn_context") {
    keep = { turn_id: p.turn_id, cwd: p.cwd, model: p.model, effort: p.effort, summary: p.summary };
  } else if (e.type === "compacted") {
    // The real record carries the whole replacement history (tens of KB here, megabytes in a long session). The tests make a long one.
    keep = { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "(earlier user message, replaced)" }] }, { type: "compaction", encrypted_content: "REDACTED" }], window_number: p.window_number };
  } else if (e.type === "event_msg" && KEEP_EVENT.has(p.type)) {
    keep = p;
  } else if (e.type === "event_msg" && p.type === "item_completed" && KEEP_ITEM.has(p.item?.type)) {
    keep = { type: p.type, thread_id: p.thread_id, turn_id: p.turn_id, item: p.item };
  } else if (e.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    keep = p;
  } else if (e.type === "response_item" && ["reasoning", "custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output"].includes(p.type)) {
    keep = p.type === "reasoning" ? { ...p, encrypted_content: "gAAAAAB-REDACTED-ENCRYPTED-REASONING" } : p;
    // An output that is the listing of installed tools (code mode's `ALL_TOOLS`): replaced by the one tool that is ours.
    if (p.type === "custom_tool_call_output" && JSON.stringify(p.output).includes("exec tool declaration")) {
      keep = { ...p, output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify([{ name: "mcp__agend__reply", description: "Reply to the user in the web chat." }]) }] };
    }
  }
  if (!keep) continue;
  if (e.type === "event_msg" && p.type === "task_started") turnNo++;
  const rec = { timestamp: e.timestamp, type: e.type, payload: keep };
  records.push(uniqueReplyIds(redactText(JSON.stringify(rec))));
}
const text = records.join("\n") + "\n";

// Refuse to write what still looks like a secret, a local path, or the user's name.
const LEAKS = [
  [/\/home\/(?!user\b)[A-Za-z0-9._-]+/, "a home directory"], [/[A-Za-z]:\\\\Users\\\\/i, "a Windows user path"],
  [/\b(sk|pk|ghp|gho|github_pat|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/, "an API key shape"], [/\beyJ[A-Za-z0-9_-]{20,}/, "a JWT"],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/i, "a bearer token"], [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, "an email address"],
  [/<timezone>(?!UTC<)/, "a time zone"], [/exec tool declaration|ChatGPT/, "the listing of installed tools"],
  [/gAAAAA(?!B-REDACTED)[A-Za-z0-9_-]{20,}/, "an encrypted blob"], [/\b\d{6}\b(?=[^"]{0,40}(code|verification))/i, "a one-time code"],
  ...(user ? [[new RegExp(user, "i"), "the OS user name"]] : []),
];
for (const [re, what] of LEAKS) { const m = re.exec(text); if (m) { console.error(`refusing to write: ${what} left: ${m[0].slice(0, 60)}`); process.exit(1); } }
writeFileSync(out, text);
console.log(`${records.length} records → ${out}`);

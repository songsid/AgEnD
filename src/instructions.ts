import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FleetInstructionsParams {
  instanceName: string;
  workingDirectory: string;
  runtimeIdentity?: {
    kind: "fleet-topic" | "classic";
    backend: string;
    model: string;
  };
  displayName?: string;
  description?: string;
  customPrompt?: string;
  workflow?: string | false;
  decisions?: { title: string; content: string }[];
  /** CLI mode: inject CLI quick reference instead of MCP tool usage section */
  cliInstructions?: string;
}

/**
 * Compact contract for the MCP server's `instructions` field.
 *
 * Some CLIs truncate MCP instructions aggressively (Claude Code cuts around
 * 2KB), so this variant carries ONLY the rules an agent cannot recover from
 * breaking mid-turn: which tool answers whom, when a turn is over, and the
 * fire-and-queue rule. Everything else — workflow, decisions, collaboration
 * niceties — travels on the additive system-prompt path
 * (fleet-instructions.md), which every backend has and nothing truncates.
 * Keep this under 2048 bytes; tests pin the budget.
 */
export function buildMcpCoreInstructions(params: FleetInstructionsParams): string {
  const { instanceName, workingDirectory, runtimeIdentity } = params;
  const runtime = runtimeIdentity
    ? ` Runtime: kind=${runtimeIdentity.kind}, backend=${runtimeIdentity.backend}, model=${runtimeIdentity.model}.`
    : "";
  return [
    `You are **${instanceName}** in an AgEnD fleet. Working directory: \`${workingDirectory}\`.${runtime}`,
    "",
    "## Reply contract",
    "- `[user:name via platform, id:ID]` → answer with the `reply` tool. Never direct text.",
    "- `[from:instance-name]` → answer with `send_to_instance`, or `report_result` with the correlation_id shown. Never `reply`.",
    "- A turn ends only after that tool call — post your conclusion, then close with a short line like `.`.",
    "- Nothing to add on a cross-instance message? Staying silent is valid.",
    "",
    "## Cross-instance protocol",
    "- `delegate_task` → work silently → `report_result` (echo correlation_id). No ack messages in between.",
    "- Send returns `{ sent, queued }` immediately — the fleet owns delivery. NEVER re-send because a reply said `queued` or an IPC wait timed out.",
    "- You only have file access under your own working directory; everything cross-instance goes through fleet tools.",
    "",
    "Full fleet guidance (workflow, decisions, collaboration rules) is in your system instructions.",
  ].join("\n");
}

export function buildFleetInstructions(params: FleetInstructionsParams): string {
  const { instanceName, workingDirectory, runtimeIdentity, displayName, description, customPrompt } = params;
  const sections: string[] = [];

  // ── Identity ──
  sections.push(`# AgEnD Fleet Context\nYou are **${instanceName}**, an instance in an AgEnD fleet.\nYour working directory is \`${workingDirectory}\`.`);
  if (runtimeIdentity) {
    sections.push(`Runtime: kind=${runtimeIdentity.kind}, backend=${runtimeIdentity.backend}, model=${runtimeIdentity.model}.`);
  }
  if (displayName) {
    sections.push(`Your display name is "${displayName}". Use this when introducing yourself.`);
  } else {
    sections.push("You don't have a display name yet. Use set_display_name to choose one that reflects your personality.");
  }
  if (description) {
    sections.push(`## Role\n${description}`);
  }

  // ── Message format & tool usage ──
  if (params.cliInstructions) {
    // CLI mode: inject CLI quick reference
    sections.push(params.cliInstructions);
  } else {
    // MCP mode: inject MCP tool usage instructions
    sections.push([
      "## Message Format",
      "- `[user:name via platform, id:USER_ID]` — from a Telegram/Discord user → reply with the `reply` tool.",
      "- `[from:instance-name]` — from another fleet instance → use `send_to_instance` or `report_result`, NOT the `reply` tool.",
      "",
      "A turn isn't finished until the channel has your conclusion — posted via `reply` (or",
      "`send_to_instance` / `report_result` for another instance). That call is the last step of",
      "the work, not your terminal text. Having nothing new to add is a valid outcome (see",
      "Silence = agreement); having a conclusion you never posted is not. Once the tool returns,",
      "close with a short line like `.` — some backends error on a turn with no text at all.",
      "",
      "## Mentioning Users & Bots",
      "- Discord: `<@USER_ID>` (e.g. `<@123456789012345678>`). Extract the id from the `id:` field in the message header.",
      "- Telegram: `@username` (plain text).",
      "- When notifying a specific user in a channel, include their mention in the reply text.",
      "- To mention another bot in collab mode, use the same format with the bot's user ID.",
      "",
      "## Tool Usage",
      "- reply: respond to users. react: add an emoji reaction — needs `message_id` + `emoji`. edit_message: update a sent message — needs `message_id` + `text`. download_attachment: fetch files.",
      "- `message_id` comes from the inbound message header line `(message_id: ... | correlation_id: ...)`.",
      "- If the inbound message has image_path, Read that file — it is a photo.",
      "- If the inbound message has attachment_file_id, call download_attachment then Read the returned path.",
      "- If the inbound message has reply_to_text, the user is quoting a previous message.",
      "- Use list_instances to discover fleet members. Use describe_instance for details.",
      "- High-level collaboration: request_information (ask), delegate_task (assign), report_result (return results with correlation_id).",
      "",
      "## Collaboration Rules",
      "1. Use fleet tools for cross-instance communication. Never assume direct file access to another instance's repo.",
      "2. Cross-instance messages appear as `[from:instance-name]`. Reply via send_to_instance or report_result, NOT reply.",
      "3. Use list_instances to discover available instances before sending messages.",
      "4. You only have direct access to files under your own working directory.",
      "5. Task flow: `delegate_task` → silent work → `report_result`. Zero messages in between. Never send ack/confirmation.",
    ].join("\n"));
  }

  // ── Workflow template ──
  if (params.workflow !== false) {
    let workflowContent: string | null = null;
    if (params.workflow) {
      workflowContent = params.workflow;
    } else {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        workflowContent = readFileSync(join(here, "workflow-templates/default.md"), "utf-8");
      } catch { /* template not found — skip */ }
    }
    if (workflowContent) {
      const trimmed = workflowContent.trim();
      if (trimmed.startsWith("#")) {
        sections.push(trimmed);
      } else {
        sections.push(`## Development Workflow\n\n${trimmed}`);
      }
    }
  }

  // ── Active decisions ──
  const decisions = params.decisions;
  if (decisions && decisions.length > 0) {
    const MAX = 15;
    const lines = decisions.slice(0, MAX).map(d => {
      const firstLine = (d.content ?? "").split(/[.\n]/)[0].trim().slice(0, 120);
      return `- **${d.title}**: ${firstLine}`;
    });
    if (decisions.length > MAX) {
      lines.push(`- *(${decisions.length - MAX} more — use \`list_decisions\` to see all)*`);
    }
    sections.push(`## Active Decisions\n\n${lines.join("\n")}`);
  }

  // ── Custom user prompt ──
  if (customPrompt) {
    sections.push(customPrompt);
  }

  return sections.join("\n\n");
}

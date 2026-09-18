import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "settings.html"),
  "utf8",
);

/** Every field path the page asks the impact schema about. */
function badgedFields(): string[] {
  return [
    ...new Set([
      ...[...html.matchAll(/impact\("([^"]+)"\)/g)].map(m => m[1]!),
      ...[...html.matchAll(/overrideControl\([^;]*?,\s*"((?:instance|classic|classic_defaults|defaults|fleet)\.[a-z_.]+)"\)/g)].map(m => m[1]!),
    ]),
  ].sort();
}

/** The keys of one `const nextPatch = {…}` literal, i.e. what a form can write. */
function patchKeys(marker: string): string[] {
  const start = html.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = html.indexOf("const nextPatch = {", start);
  expect(open, `no nextPatch after ${marker}`).toBeGreaterThan(-1);
  let braces = 0;
  let end = open;
  for (let i = html.indexOf("{", open); i < html.length; i++) {
    if (html[i] === "{") braces++;
    else if (html[i] === "}" && --braces === 0) { end = i; break; }
  }
  const body = html.slice(html.indexOf("{", open) + 1, end);
  // Depth 0 keys only, scanned character by character: several keys share a
  // line, and nested values (hang_detector) carry their own braces.
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let token = "";
  for (const ch of body) {
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; token = ""; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; token = ""; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; token = ""; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) { token += ch; continue; }
    // camelCase counts too: systemPrompt is a field like any other.
    if (ch === ":" && depth === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) keys.push(token);
    token = "";
  }
  return [...new Set(keys)].sort();
}

/**
 * Every field the panel rendered before the redesign.
 *
 * The redesign moves settings from long inline forms into per-object modals and
 * a single Advanced drawer. Moving a control is fine; losing one is not, and a
 * screenshot cannot tell the difference. This list is what "nothing was removed
 * or locked away" means concretely.
 */
const PRE_REDESIGN_FIELDS = [
  "classic.admin_users", "classic.allowed_guilds", "classic.auto_pause_after",
  "classic.backend", "classic.collab", "classic.context_lines", "classic.model",
  "classic.reply_completion_guard", "classic.tool_progress",
  "classic_defaults.backend", "classic_defaults.reply_completion_guard",
  "classic_defaults.tool_progress",
  "defaults.agent_mode", "defaults.auto_pause_after", "defaults.backend",
  "defaults.hang_detector", "defaults.locale", "defaults.log_level",
  "defaults.model", "defaults.reply_completion_guard", "defaults.tool_progress",
  "defaults.tool_set",
  "fleet.channel.access.allowed_users", "fleet.channel.access.mode",
  "fleet.spawn_concurrency", "fleet.spawn_stagger_ms",
  "instance.auto_pause_after", "instance.backend", "instance.description",
  "instance.display_name", "instance.general_topic", "instance.hang_detector",
  "instance.log_level", "instance.model", "instance.reply_completion_guard",
  "instance.systemPrompt", "instance.tags", "instance.tool_progress",
  "instance.topic_id", "instance.working_directory",
];

describe("the redesigned panel loses nothing", () => {
  it("still renders every field the old layout had", () => {
    const rendered = badgedFields();
    for (const field of PRE_REDESIGN_FIELDS) {
      expect(rendered, `${field} disappeared from the panel`).toContain(field);
    }
  });

  it("asks the schema about every field it renders", () => {
    const schema = buildSettingsImpactSchema();
    for (const field of badgedFields()) {
      expect(schema.impacts, `settings.html asks for "${field}"`).toHaveProperty(field);
    }
  });

  it("can still write every agent setting", () => {
    expect(patchKeys("function agentEditForm")).toEqual([
      "agent_mode", "auto_pause_after", "backend", "channel_id", "description",
      "display_name", "general_topic", "hang_detector", "lightweight",
      "log_level", "model", "model_failover", "reply_completion_guard",
      "systemPrompt", "tags", "tool_progress", "tool_set", "working_directory",
    ]);
  });

  it("can still write every ClassicBot channel setting", () => {
    expect(patchKeys("function classicEditForm")).toEqual([
      "auto_pause_after", "backend", "collab", "context_lines", "model",
      "reply_completion_guard", "tool_progress",
    ]);
  });
});

/** The body of a top-level `function name(...) { … }` in the page script. */
function functionBody(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

const EDITORS = ["agentEditForm", "botEditForm", "classicEditForm"];

describe("a modal edits one object and never submits by itself", () => {
  it.each(EDITORS)("%s reaches the API only through a staged apply", name => {
    const body = functionBody(name);
    // Every call to api() inside an editor must be the `apply` of a staged
    // change. A direct call is a write that happens on close, which is exactly
    // what the redesign removed — the old bot editor did it.
    for (const match of body.matchAll(/api\(/g)) {
      const before = body.slice(Math.max(0, match.index! - 80), match.index!);
      expect(before, `${name} calls api() outside a staged apply`).toMatch(/apply:\s*\(\)\s*=>\s*$/);
    }
  });

  it.each(EDITORS)("%s hands the caller a stage() instead of its own buttons", name => {
    const body = functionBody(name);

    expect(body, `${name} must expose stage()`).toMatch(/stage:\s*\(\)\s*=>/);
    // No Save/Cancel of its own: the modal footer owns those, so one click
    // cannot both close the form and write.
    expect(body).not.toMatch(/t\("save"\)/);
    expect(body).not.toMatch(/t\("cancel"\)/);
  });

  it.each(EDITORS)("%s puts its advanced settings in an expandable drawer", name => {
    expect(functionBody(name), `${name} has no drawer`).toContain('drawer(t("advancedSection")');
  });

  it("renders the drawer as a real disclosure, not a hidden mode", () => {
    expect(html).toContain('el("details", { class: "drawer" })');
    expect(html).toContain('el("summary", {}, title)');
    // The mode that used to hide a whole level is gone.
    expect(html).not.toContain("show-advanced");
    expect(html).not.toContain("agend_settings_advanced");
  });

  it("stages on Done and discards on Cancel, and neither writes", () => {
    expect(html).toContain('$("modalDone").onclick = () => { if (modalState?.stage() !== false) closeModal(); };');
    expect(html).toContain('$("modalCancel").onclick = () => closeModal();');
    // Applying is still only the pending bar's button.
    expect(html).toContain('$("applyChanges").onclick = applyPendingChanges;');
  });

  it("summarises the whole modal's impact in the footer", () => {
    expect(html).toContain('const kinds = [...new Set((impacts || []).map(impactOf))];');
    expect(html).toContain('$("modalImpact").textContent');
  });
});

describe("the lists are rows with a Settings button", () => {
  it.each([
    ["compactRow", "agentEditForm"],
    ["renderBots", "botEditForm"],
    ["renderClassic", "classicEditForm"],
  ])("%s opens %s in a modal rather than expanding in place", (row, form) => {
    const body = functionBody(row);

    expect(body).toContain(`${form}(`);
    expect(body).toContain("openModal({");
    expect(body).toContain('t("settingsButton")');
  });

  it("filters agents, ClassicBot channels and connections from one search box", () => {
    expect(html).toContain('$("agentSearch").oninput = () => { renderAgents(); renderClassic(); renderBots(); };');
    for (const name of ["renderAgents", "renderClassic", "renderBots"]) {
      const body = functionBody(name);
      expect(body, `${name} ignores the search box`).toContain('$("agentSearch")?.value');
      // …and does something with it. Reading the box and rendering everything
      // anyway is the same as not searching.
      expect(body, `${name} reads the filter but never applies it`).toMatch(/if \(filter\)/);
    }
  });

  it("shows the connection's access on its row", () => {
    const body = functionBody("renderBots");

    expect(body).toContain('ch.access?.mode');
    expect(body).toContain("allowed_users");
  });

  it("asks only for the id the chosen platform has", () => {
    // Discord has a guild, Telegram has a group; the CLI already asks this way.
    expect(functionBody("botEditForm")).toContain('type === "discord" ? t("guildIdField") : t("groupIdField")');
  });
});

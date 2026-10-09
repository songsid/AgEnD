import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

// The Settings UI is the app shell's panel and its modules (#1408 step 3): settings.html is gone. Its source is read
// as text, as the old page was, from the files that now hold each part of it.
const UI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui");
const FILES = ["panel-settings.js", "settings-dialogs.js", "settings-model.js", "settings-wizard.js"];
const sources = Object.fromEntries(FILES.map(f => [f, readFileSync(join(UI, f), "utf8")]));
const ui = Object.values(sources).join("\n");

/** The keys of the object literal that follows `marker` in `source`, depth-0 only (nested values carry their own braces). */
function literalKeys(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let token = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; token = ""; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; token = ""; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; token = ""; if (depth === 0) break; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) { token += ch; continue; }
    // camelCase counts too: systemPrompt is a field like any other.
    if (ch === ":" && depth === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) keys.push(token);
    token = "";
  }
  return [...new Set(keys)].sort();
}

/** Every field path the Settings UI names: literal ones, and the ones its forms build from their keys. */
function badgedFields(): string[] {
  const literal = [
    ...[...ui.matchAll(/impact(?:Of)?\(\s*(?:schema,\s*)?"([^"]+)"\)/g)].map(m => m[1]!),
    // A field's label carries its path: L(tn("…"), "classic.admin_users"), field="instance.backend", and so on.
    ...[...ui.matchAll(/"((?:instance|classic|classic_defaults|defaults|fleet|web)\.[a-z_]+(?:\.[a-z_]+)*)"/g)].map(m => m[1]!),
  ];
  const built = [
    ...literalKeys(sources["settings-model.js"]!, "const next = {").map(k => `instance.${k}`),
    ...literalKeys(sources["settings-dialogs.js"]!, "const patch = changedFields({").map(k => `classic.${k}`),
    // A defaults key is its own field, except `startup`: the fleet's spawn settings, which the schema names on their own
    // (settings-model.js defaultsImpact).
    ...literalKeys(sources["panel-settings.js"]!, "const defaultsPatch = changedFields({")
      .flatMap(k => (k === "startup" ? ["fleet.spawn_concurrency", "fleet.spawn_stagger_ms"] : [`defaults.${k}`])),
  ];
  // "fleet.yaml" is the Developer view's download name, not a field.
  return [...new Set([...literal, ...built])].filter(f => f !== "fleet.yaml").sort();
}

/** The keys of one `const nextPatch = {…}` literal, i.e. what a form can write. */
function patchKeys(file: string, marker: string): string[] {
  return literalKeys(sources[file]!, marker);
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
      expect(schema.impacts, `the settings UI asks for "${field}"`).toHaveProperty(field);
    }
  });

  it("can still write every agent setting", () => {
    expect(patchKeys("settings-model.js", "const next = {")).toEqual([
      "agent_mode", "auto_pause_after", "backend", "channel_id", "cross_instance_visibility", "description",
      "display_name", "general_topic", "hang_detector", "lightweight",
      "log_level", "model", "model_failover", "reply_completion_guard",
      "status_emojis", "systemPrompt", "tags", "tool_progress", "tool_set", "working_directory",
    ]);
  });

  it("can still write every ClassicBot channel setting", () => {
    expect(patchKeys("settings-dialogs.js", "const patch = changedFields({")).toEqual([
      "auto_pause_after", "backend", "collab", "context_lines", "model",
      "reply_completion_guard", "tool_progress", "web_echo",
    ]);
  });
});

/** The body of a top-level `function name(...) { … }` in the page script. */
function functionBody(name: string): string {
  const start = ui.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  // The body opens after the parameter list (a destructured parameter has braces of its own).
  let depth = 0;
  for (let i = ui.indexOf(") {", start) + 2; i < ui.length; i++) {
    if (ui[i] === "{") depth++;
    else if (ui[i] === "}" && --depth === 0) return ui.slice(start, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

const EDITORS = ["AgentDialog", "BotDialog", "ClassicDialog"];

describe("a modal edits one object and never submits by itself", () => {
  it.each(EDITORS)("%s reaches the API only through a staged apply", name => {
    const body = functionBody(name);
    // An editor never calls the API itself: its change is staged, and the Apply runner writes it on confirmation.
    expect(body, `${name} calls api() directly`).not.toMatch(/\bapi\(/);
    expect(body, `${name} does not stage its change`).toMatch(/ctx\.stage[A-Za-z]*\(/);
  });

  it.each(EDITORS)("%s hands the caller a stage() instead of its own buttons", name => {
    const body = functionBody(name);

    // No Save/Cancel of its own: the modal footer owns those, so one click cannot both close the form and write.
    expect(body).not.toMatch(/t\("save"\)/);
    expect(body).not.toMatch(/t\("cancel"\)/);
  });

  it.each(EDITORS)("%s puts its advanced settings in an expandable drawer", name => {
    expect(functionBody(name), `${name} has no drawer`).toContain("<${Drawer}");
    expect(functionBody(name)).toContain("advancedSection");
  });

  it("renders the drawer as a real disclosure, not a hidden mode", () => {
    const drawer = ui.slice(ui.indexOf("export function Drawer("), ui.indexOf("export function Drawer(") + 400);
    expect(drawer).toContain('<details class="drawer"');
    expect(drawer).toContain("<summary>");
    // The mode that used to hide a whole level is gone.
    expect(ui).not.toContain("show-advanced");
    expect(ui).not.toContain("agend_settings_advanced");
  });

  it.each(EDITORS)("%s stages on Done and discards on Cancel, and neither writes", name => {
    // Done is the footer's stage; Cancel closes. Neither writes: the pending bar's Apply does.
    const body = functionBody(name);
    expect(body).toContain("onStage=${stage}");
    expect(body).toContain("onClose=${onClose}");
    expect(sources["panel-settings.js"]).toContain("onApply=${apply}");
  });

  it.each(EDITORS)("%s summarises the whole modal's impact in the footer", name => {
    expect(functionBody(name), `${name} has no footer impact`).toContain("impacts=");
  });
});

describe("the lists are rows with a Settings button", () => {
  it.each([
    ["Agents", "agent"],
    ["Bots", "bot"],
    ["Classic", "classic"],
  ])("%s opens its editor in a modal rather than expanding in place", (list, kind) => {
    const body = functionBody(list);

    expect(body).toContain(`kind: "${kind}"`);
    expect(body).toContain("openDialog");
    expect(ui).toContain("settingsButton");
  });

  it("filters agents, ClassicBot channels and connections from one search box", () => {
    expect(sources["panel-settings.js"]).toContain("onInput=${(e) => setSearch(e.target.value)}");
    for (const name of ["Agents", "Classic", "Bots"]) {
      const body = functionBody(name);
      expect(body, `${name} ignores the search box`).toContain("search");
    }
    // ...and does something with it. Reading the box and rendering everything anyway is the same as not searching.
    expect(sources["settings-model.js"]).toMatch(/groupAgents\(/);
    expect(functionBody("Agents")).toMatch(/groupAgents\(insts, ctx\.live, search\)/);
  });

  it("shows the connection's access on its row", () => {
    expect(ui).toContain("allowed_users");
    expect(ui).toMatch(/access\??\.mode/);
  });

  it("asks only for the id the chosen platform has", () => {
    // Discord has a guild, Telegram has a group; the CLI already asks this way.
    expect(ui).toMatch(/discord[^\n]*guildIdField[^\n]*groupIdField|discord[^\n]*"guildIdField"/);
  });
});

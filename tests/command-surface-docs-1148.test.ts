import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS, TELEGRAM_MENUS, type CommandScope, type PlatformRule } from "../src/command-table.js";

// Data/docs only. The real-handler exceptions are also pinned by
// command-gates-by-platform; no platform/backend/fleet construction here.
const scopes: CommandScope[] = ["general", "fleet", "classic", "none"];
const languages = ["", ".zh-TW"];
function tables(suffix: string) {
  const text = readFileSync(new URL(`../docs/command-surface${suffix}.md`, import.meta.url), "utf8");
  const rows = [...text.matchAll(/^\| `\/(\w+)` \| (.*) \|$/gm)].map(m => [m[1], m[2].split(" | ")] as const);
  return { discord: rows.filter(([, cells]) => cells.length === 5), telegram: rows.filter(([, cells]) => cells.length === 7) };
}
function cell(rule: PlatformRule, scope: CommandScope): string {
  if ("passthrough" in rule) return "P";
  if ("refuse" in rule) return rule.refuse[0] === "cmd.use_in_general" ? "R:G" : "R";
  return "H:" + ({ anyone: "A", "fleet-admin": "F", "classic-admin": "C", handler: "start",
    "channel-admin": scope === "classic" ? "F/C" : "F" })[rule.level];
}
function telegramCells(spec: typeof COMMANDS[number]): string[] {
  const result = scopes.map(scope => cell(spec.telegram[scope], scope));
  if (spec.name === "start") result[2] = "R:active"; // existing registration already has an agent
  if (spec.name === "chat") result[2] = "P"; // Classic has ordinary wrapping, no special /chat dispatcher
  if (["pause", "wake", "compact", "clear", "model", "save"].includes(spec.name)) result[3] = "R(F)";
  if (spec.name === "stop") result[3] = "R(C)";
  if (spec.name === "tips") { result[0] += "*"; result[1] += "*"; }
  // An addressed unsupported group command is not a conversational mention.
  // A separate mention can forward it; unregistered chats instead say no agent.
  return [result[0], result[1], result[2], result[2] === "P" ? "S/P" : result[2], result[3] === "P" ? "S/R" : result[3]];
}

describe("#1148 bilingual real command surface", () => {
  for (const language of languages) {
    it(`pins all names, menu membership and effective cells (${language || "en"})`, () => {
      const docs = tables(language);
      expect(docs.discord.map(([name]) => name)).toEqual(COMMANDS.map(spec => spec.name));
      expect(docs.telegram.map(([name]) => name)).toEqual(COMMANDS.map(spec => spec.name));
      for (const spec of COMMANDS) {
        const dc = docs.discord.find(([name]) => name === spec.name)![1];
        const tg = docs.telegram.find(([name]) => name === spec.name)![1];
        expect(dc, `Discord /${spec.name}`).toEqual([spec.slash ? "✓" : "—", ...scopes.map(scope => {
          const value = cell(spec.scopes[scope], scope);
          return spec.name === "tips" ? value + "*" : value;
        })]);
        expect(tg, `Telegram /${spec.name}`).toEqual([
          (TELEGRAM_MENUS.fleet.names as readonly string[]).includes(spec.name) ? "✓" : "—",
          (TELEGRAM_MENUS.classic.names as readonly string[]).includes(spec.name) ? "✓" : "—",
          ...telegramCells(spec),
        ]);
      }
    });
  }
  it("keeps the two languages' matrix bytes identical", () => {
    expect(tables(".zh-TW")).toEqual(tables(""));
  });
});

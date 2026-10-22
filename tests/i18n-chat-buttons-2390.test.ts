/**
 * #2390: a button a person presses in Discord or Telegram reads in the fleet's language. Users on 2.3.0-beta.22 saw an
 * English "Confirm" / "Reject" on the settings confirmation card: its labels were literals, not locale keys.
 *
 * This scan fails when fleet code (src/**, not the web UI) builds a chat button whose label is English text written in
 * place instead of t("…"): a prompt choice `{ action, label: "…" }`, a Discord `.setLabel("…")`, a Telegram keyboard
 * `.text("…", data)`. Text inside `${…}` is a value, not wording, and a label of symbols only (emoji, "·") is not English.
 * The allowlist is the few labels that predate the audit; each names why it stays.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "src");
/** file: literal — kept on purpose. */
const ALLOWED = new Set([
  // Tool-permission prompts (before v2.2.6; out of the #2390 scope, which is what 2.2.6 → 2.3 added).
  "channel/adapters/discord.ts: Allow", "channel/adapters/discord.ts: Always", "channel/adapters/discord.ts: Deny",
  "channel/adapters/telegram.ts: ✅ Allow (${…})", "channel/adapters/telegram.ts: ✅ Always", "channel/adapters/telegram.ts: ❌ Deny",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "ui" && dir === ROOT ? [] : files(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}
/** A string or template literal's wording: `${…}` stands for a value. */
const wording = (literal: string) => literal.slice(1, -1).replace(/\$\{[^}]*\}/g, "${…}");
const english = (text: string) => /[A-Za-z]{2}/.test(text.replace(/\$\{…\}/g, ""));
const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`)";
const SHAPES = [
  new RegExp(String.raw`\baction:\s*[^,{}]+,\s*label:\s*` + LITERAL, "g"),       // a prompt choice
  new RegExp(String.raw`\.setLabel\(\s*` + LITERAL, "g"),                        // a Discord button
  new RegExp(String.raw`\.text\(\s*` + LITERAL + String.raw`\s*,`, "g"),         // a Telegram keyboard button
];

export function englishButtonLabels(root = ROOT): string[] {
  const found: string[] = [];
  for (const file of files(root)) {
    const src = readFileSync(file, "utf8");
    for (const shape of SHAPES) for (const m of src.matchAll(shape)) {
      const text = wording(m[1]!);
      if (english(text)) found.push(`${relative(root, file)}: ${text}`);
    }
  }
  return found;
}

describe("#2390 chat buttons go through the locale layer", () => {
  it("no chat button label is English written in place (allowlist: the pre-2.2.6 permission prompt)", () => {
    expect(englishButtonLabels().filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it("the allowlist is still needed: every entry is a label the scan finds", () => {
    const found = new Set(englishButtonLabels());
    expect([...ALLOWED].filter((a) => !found.has(a))).toEqual([]);
  });

  it("the scan sees each shape (so a pass means something)", () => {
    const sample = (code: string) => SHAPES.some((s) => [...code.matchAll(new RegExp(s.source, "g"))].some((m) => english(wording(m[1]!))));
    expect([
      sample(`choices: [{ action: "confirm", label: "Confirm" }]`),
      sample(`new ButtonBuilder().setLabel("Retry")`),
      sample("kb.text(`Open ${name}`, data)"),
      sample(`choices: [{ action: "confirm", label: t("settings_confirm.confirm_button") }]`),
      sample("kb.text(`${backend} · ${state}`, data)"),
      sample(`kb.text("✅", data)`),
    ]).toEqual([true, true, true, false, false, false]);
  });
});

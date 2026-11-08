/**
 * S-92 (#3326 D1): the restart words for a fleet with no chat connection live in src/ui/settings-restart-strings.js — a new
 * URL, so no open tab holds an old copy (the pattern of settings-shared-strings.js, #3087; settings-access-strings.js, #3061).
 *   - Ownership: its keys are in it only (never also in settings-strings.js); the same keys in en and zh-TW.
 *   - Readers: every src/ui module that names one of its keys imports it.
 *   - The words never send anyone to a host command.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui");
const FILE = "settings-restart-strings.js";
const src = readFileSync(join(UI, FILE), "utf8");
const table = new Function(`return (${src.slice(src.indexOf("register(\"settings\", ") + 'register("settings", '.length, src.lastIndexOf(");"))})`)() as Record<"en" | "zh-TW", Record<string, string>>;
const KEYS = Object.keys(table.en);

describe("settings-restart-strings.js (S-92)", () => {
  it("owns its keys, in both languages", () => {
    expect(KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(table["zh-TW"]).sort()).toEqual([...KEYS].sort());
    const old = readFileSync(join(UI, "settings-strings.js"), "utf8");
    for (const k of KEYS) expect(new RegExp(`\\b${k}\\s*:`).test(old), `${k} also in settings-strings.js`).toBe(false);
  });
  it("every module that reads one of its keys imports it", () => {
    const readers = readdirSync(UI).filter(f => f.endsWith(".js") && f !== FILE)
      .filter(f => KEYS.some(k => readFileSync(join(UI, f), "utf8").includes(`"${k}"`)));
    expect(readers).toContain("panel-settings.js");
    for (const f of readers) expect(readFileSync(join(UI, f), "utf8"), f).toContain(`import "./${FILE}"`);
  });
  it("never a host command", () => {
    for (const lang of ["en", "zh-TW"] as const) for (const k of KEYS) expect(table[lang][k]).not.toMatch(/agend |`|在主機上|on the host/);
  });
});

/**
 * Hub rooms strings (hub-rooms-ux.md §§2–12): own namespace, both languages, no Fleet imports.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uiDictionaries } from "./helpers/ui-dictionaries.js";

const FILE = "src/ui/hub-room-strings.js";
const SRC = readFileSync(FILE, "utf8");
const placeholders = (s: string) => (s.match(/\{\d\}/g) ?? []).join(",");

describe("hub-room-strings.js", () => {
  const d = uiDictionaries(FILE);
  const en = d.strings.filter((s) => s.lang === "en");
  const zh = d.strings.filter((s) => s.lang === "zh-TW");
  const enKeys = new Set(en.map((s) => s.key));
  const zhKeys = new Set(zh.map((s) => s.key));

  it("registers hubRoom only; every value is a readable literal", () => {
    expect(d.unread).toEqual([]);
    expect([...new Set(d.strings.map((s) => s.ns))]).toEqual(["hubRoom"]);
    expect(en.length).toBeGreaterThan(80);
  });

  it("both languages have the same keys, none empty", () => {
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([]);
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    for (const s of d.strings) {
      expect(s.key, `${s.lang}.${s.key}`).toBeTruthy();
      expect(s.text.trim(), `${s.ns}.${s.key} [${s.lang}]`).not.toBe("");
    }
  });

  it("{0} placeholders match across languages", () => {
    const zhByKey = new Map(zh.map((s) => [s.key, s.text]));
    for (const s of en) expect(placeholders(zhByKey.get(s.key)!), s.key).toBe(placeholders(s.text));
  });

  it("imports only app-i18n (nothing from the Fleet)", () => {
    const imports = [...SRC.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual(['import { register, t } from "/assets/app-i18n.js";']);
  });

  it("exports hroom() on the hubRoom namespace", () => {
    expect(SRC).toContain("register(\"hubRoom\"");
    expect(SRC).toMatch(/export const hroom = \(key, \.\.\.values\) => t\(`hubRoom\.\$\{key\}`/);
  });

  it("carries the spec §1 terms and a label from each of §§2–12", () => {
    const byKey = Object.fromEntries(en.map((s) => [s.key, s.text]));
    expect(byKey.room).toBe("Room");
    expect(byKey.roomAssistant).toBe("Room assistant");
    expect(byKey.mentionAll).toBe("@All agents");
    expect(byKey.newRoom).toBe("+ New room");                 // §2
    expect(byKey.askProgress).toContain("reply later");       // §3
    expect(byKey.errAllMention).toMatch(/room manager/);      // §4
    expect(byKey.membersHead).toMatch(/Members/);             // §5
    expect(byKey.nameRequired).toBe("Enter a room name.");    // §6
    expect(byKey.archiveAsk).toMatch(/read-only/);            // §7
    expect(byKey.agree).toBe("Agree");                        // §8
    expect(byKey.whoSeesDirect).toMatch(/Only you see this chat/); // §9
    expect(byKey.askSummarise).toMatch(/summarise/);          // §10
    expect(byKey.whoCanCreate).toBe("Who can start rooms");   // §11
    expect(byKey.unreadPrefix).toBe("({0})");                 // §12
    expect(byKey.unreadN).toBe("{0} unread");
    expect(byKey.mentionedYou).toBe("Mentioned you");
    const zhBy = Object.fromEntries(zh.map((s) => [s.key, s.text]));
    expect(zhBy.addPeople).toContain("AD 群組");
    expect(zhBy.room).toBe("房間");
    expect(zhBy.unreadN).toBe("{0} 則未讀");
    expect(zhBy.mentionedYou).toBe("有人 @ 你");
  });
});

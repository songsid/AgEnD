/**
 * M1 (Hub rooms, spec §5): hub-room-presence.js against the seam-1 fixture.
 * Every Member.presence value and both presenceNote examples render in EN and
 * zh-TW with no raw key in the output; the Agents list order, header counts
 * and the overflow split match the spec.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let P: any;
let i18n: any;
let hroom: (key: string, ...values: unknown[]) => string;

beforeAll(async () => {
  // @ts-expect-error browser module without types
  P = await import("../src/ui/hub-room-presence.js");
  // @ts-expect-error browser module
  ({ hroom } = await import("../src/ui/hub-room-strings.js"));
  i18n = await import("/assets/app-i18n.js");
});
afterEach(() => { i18n.setLang("en", { store: false }); });

const byName = (fx: any, name: string) => fx.rooms[0].members.find((m: any) => m.name === name);

describe("presenceView", () => {
  it("maps every presence to its dot and hubRoom word", () => {
    const fx = createHubRoomsFixture();
    expect(P.presenceView(byName(fx, "王經理"))).toEqual({ dot: "online", word: "stOnline" });
    expect(P.presenceView(byName(fx, "吳小安"))).toEqual({ dot: "offline", word: "stOffline" });
    expect(P.presenceView(byName(fx, "project-helper"))).toEqual({ dot: "working", word: "stWorking" });
    expect(P.presenceView(byName(fx, "spec-writer"))).toEqual({ dot: "online", word: "stIdle" });
    expect(P.presenceView(byName(fx, "report-bot"))).toEqual({ dot: "offline", word: "stOffline" });
    expect(P.presenceView(byName(fx, "desk-notes"))).toEqual({ dot: "offline", word: "stLater" });
  });
  it("pauses carry their reason key; 需要更新 AgEnD is its own offline word", () => {
    const fx = createHubRoomsFixture();
    expect(P.presenceView(byName(fx, "schedule-bot"))).toEqual({ dot: "paused", word: "stPaused", noteKey: "pauseQuota" });
    expect(P.presenceView(byName(fx, "infra-watch"))).toEqual({ dot: "paused", word: "stPaused", noteKey: "pauseSignIn" });
    expect(P.presenceView(byName(fx, "old-helper"))).toEqual({ dot: "offline", word: "needsUpdate" });
  });
  it("an unrecognised note goes to noteText verbatim, never through hroom", () => {
    const odd = { kind: "agent", name: "x", presence: "paused", presenceNote: "Quota exhausted" };
    expect(P.presenceView(odd)).toEqual({ dot: "paused", word: "stPaused", noteText: "Quota exhausted" });
    const fx = createHubRoomsFixture();
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false });
      expect(hroom(P.presenceView(odd).word), lang).not.toContain("hubRoom.");
      expect(P.presenceView(odd).noteText, lang).toBe("Quota exhausted");
      expect("noteKey" in P.presenceView(odd), lang).toBe(false);
    }
  });
  it("the room assistant pauses as 暫時無法回答", () => {
    const fx = createHubRoomsFixture();
    const assistant = byName(fx, "房間助理");
    expect(P.presenceView(assistant)).toEqual({ dot: "online", word: "stIdle" });
    expect(P.presenceView({ ...assistant, presence: "working" })).toEqual({ dot: "working", word: "stWorking" });
    fx.setAssistant("paused");
    expect(P.presenceView(byName(fx, "房間助理"))).toEqual({ dot: "paused", word: "stAssistantDown" });
  });
  it("every emitted key renders in EN and zh-TW — no raw key in the output", () => {
    const fx = createHubRoomsFixture();
    const views = fx.rooms[0].members.map((m: any) => P.presenceView(m));
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false });
      for (const v of views) {
        expect(hroom(v.word), `${lang}.${v.word}`).not.toBe(v.word);
        expect(hroom(v.word), `${lang}.${v.word}`).not.toContain("hubRoom.");
        if (v.noteKey) {
          expect(hroom(v.noteKey), `${lang}.${v.noteKey}`).not.toBe(v.noteKey);
          expect(hroom(v.noteKey), `${lang}.${v.noteKey}`).not.toContain("hubRoom.");
        }
      }
    }
  });
  it("renders the spec's words", () => {
    const fx = createHubRoomsFixture();
    i18n.setLang("en", { store: false });
    expect(hroom(P.presenceView(byName(fx, "project-helper")).word)).toBe("Working");
    expect(hroom(P.presenceView(byName(fx, "schedule-bot")).noteKey)).toBe("Out of quota");
    expect(hroom(P.presenceView(byName(fx, "old-helper")).word)).toBe("Needs an AgEnD update");
    i18n.setLang("zh-TW", { store: false });
    expect(hroom(P.presenceView(byName(fx, "project-helper")).word)).toBe("處理中");
    expect(hroom(P.presenceView(byName(fx, "schedule-bot")).noteKey)).toBe("額度用完");
    expect(hroom(P.presenceView(byName(fx, "old-helper")).word)).toBe("需要更新 AgEnD");
    expect(hroom(P.presenceView(byName(fx, "desk-notes")).word)).toBe("上線時回答");
  });
});

describe("presenceDot", () => {
  it("maps every presence to the Fleet sidebar dot class", () => {
    expect(["online", "idle", "working", "paused", "offline", "later"].map((p) => P.presenceDot(p))).toEqual(["ok", "ok", "busy", "warn", "off", "off"]);
    expect(P.presenceDot("unknown")).toBe("off");
    expect(P.presenceDot(undefined)).toBe("off");
  });
});

describe("sortAgents", () => {
  it("orders working, idle, paused, offline, later — stable by name", () => {
    const fx = createHubRoomsFixture();
    expect(P.sortAgents(fx.rooms[0].members).map((m: any) => m.name)).toEqual([
      "budget-check", "project-helper",
      "design-review", "doc-search", "release-notes", "spec-writer", "test-runner",
      "infra-watch", "schedule-bot",
      "old-helper", "report-bot",
      "desk-notes",
    ]);
  });
  it("keeps people and the room assistant out of the agents list", () => {
    const fx = createHubRoomsFixture();
    const names = P.sortAgents(fx.rooms[0].members).map((m: any) => m.name);
    expect(names).not.toContain("王經理");
    expect(names).not.toContain("房間助理");
    expect(names).toHaveLength(12);
  });
});

describe("headerCounts", () => {
  it("counts agents and people, online in both languages", () => {
    const fx = createHubRoomsFixture();
    i18n.setLang("zh-TW", { store: false });
    expect(P.headerCounts(fx.rooms[0].members)).toEqual({ agent: "Agent · 12（線上 7）", member: "成員 · 3（線上 2）" });
    i18n.setLang("en", { store: false });
    expect(P.headerCounts(fx.rooms[0].members)).toEqual({ agent: "Agents · 12 (online 7)", member: "Members · 3 (online 2)" });
  });
});

describe("collapse", () => {
  it("splits the shown rows from the folded rest", () => {
    expect(P.collapse([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8)).toEqual({ shown: [1, 2, 3, 4, 5, 6, 7, 8], rest: 2 });
    expect(P.collapse([1, 2, 3], 8)).toEqual({ shown: [1, 2, 3], rest: 0 });
    i18n.setLang("zh-TW", { store: false });
    expect(hroom("moreN", 2)).toBe("… 其餘 2 個");
    i18n.setLang("en", { store: false });
    expect(hroom("moreN", 2)).toBe("… 2 more");
  });
});

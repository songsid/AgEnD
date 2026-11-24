/**
 * M-3533 R2a: a room's agents in the member list wear their owner's look — the persona emoji, else the initial, on the
 * identity colour (else the default tint) — in the source mark's slot, with no badge (every agent's was the same logo);
 * the row's text is still the name, the source in its title, accessible name and card. Classic and compact lists alike.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

let panel: any, i18n: any, clientModule: any, presence: any;
const mounted: AppPage[] = [];
beforeAll(async () => { const p = page(); panel = await import("/ui/js/hub-room-members.js"); i18n = await import("/assets/app-i18n.js"); clientModule = await import("/ui/js/hub-client.js"); presence = await import("/ui/js/hub-room-presence.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } i18n.setLang("en", { store: false }); });

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, kind: "agent", name, role: "member", presence: "idle", owner: { name: "Alex" }, ...extra });
const detail = (members: unknown[]) => ({ room: { id: "r", kind: "group", name: "Room" }, me: { id: "me", role: "member" }, settings: {}, invited: [],
  members: [{ id: "me", kind: "person", name: "Me", role: "member", presence: "online", signedIn: true }, ...members] });

describe("agentAvatar (pure)", () => {
  it("the emoji, else the initial; on the colour with readable ink, else the default tint", () => {
    expect(panel.agentAvatar({ name: "Notes", look: { color: "#D97757", emoji: "🦊" } })).toEqual({ color: "#d97757", text: "🦊", emoji: true, ink: "#111111" });
    expect(panel.agentAvatar({ name: "Notes", look: { color: "#1a2b6d" } })).toEqual({ color: "#1a2b6d", text: "N", emoji: false, ink: "#ffffff" });
    expect(panel.agentAvatar({ name: "Notes" })).toEqual({ color: null, text: "N", emoji: false, ink: null });
    // Anything that is not a #rrggbb colour or a non-blank emoji is ignored: the initial on the default tint.
    expect(panel.agentAvatar({ name: "Notes", look: { color: "red", emoji: "  " } })).toEqual({ color: null, text: "N", emoji: false, ink: null });
  });
  it("an emoji label longer than one character (the catalog allows 64 bytes) gives the initial; one emoji with joiners or modifiers stays", () => {
    const long = "x".repeat(64);
    for (const label of [long, "🦊🐙", ":party-parrot:", "ab"]) expect(panel.agentAvatar({ name: "Notes", look: { emoji: label } })).toMatchObject({ text: "N", emoji: false });
    for (const one of ["👩‍💻", "👍🏽", "🇹🇼", "🦊"]) expect(panel.agentAvatar({ name: "Notes", look: { emoji: one } })).toMatchObject({ text: one, emoji: true });
  });
  it("the ink is whichever painted ink (#111111 or white) has more contrast, mid-grey included", () => {
    // #767676: white 4.54:1 against #111111's 4.16:1. #808080: #111111 4.78:1 against white's 3.95:1.
    expect(panel.agentAvatar({ name: "N", look: { color: "#767676" } }).ink).toBe("#ffffff");
    expect(panel.agentAvatar({ name: "N", look: { color: "#808080" } }).ink).toBe("#111111");
    expect(panel.agentAvatar({ name: "N", look: { color: "#000000" } }).ink).toBe("#ffffff");
    expect(panel.agentAvatar({ name: "N", look: { color: "#ffffff" } }).ink).toBe("#111111");
  });
});

describe("the member list", () => {
  it.each([[false], [true]])("an agent row: the avatar in the slot, no badge, the name alone as its text, the source in its title (compact %s)", async (compact) => {
    const p = page(); mounted.push(p);
    const client = clientModule.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    const members = [agent("e1", "Notes", { look: { color: "#d97757", emoji: "🦊" } }), agent("e2", "Planner", { look: { color: "#1a2b6d" } }), agent("e3", "Old", { agentKind: "personal" })];
    await p.mount(h(panel.RoomMembersPanel, { client, roomId: "r", detail: detail(members), compact })); await settle(20);
    if (compact) for (const d of [...p.root.querySelectorAll("details")] as any[]) { d.setAttribute("open", ""); d.open = true; }
    await settle(5);
    const rows = [...p.root.querySelectorAll(".hub-member-agent .hub-member-open")] as any[];
    const got = rows.map((b) => { const av = b.querySelector(".hub-agent-av"); return [b.querySelector(".hub-member-name").textContent.trim(), av.getAttribute("data-av"), (av.style?.["--av"] ? `--av:${av.style["--av"]};--av-ink:${av.style["--av-ink"]}` : "") + (av.getAttribute("style") ?? ""), b.querySelector("[data-room-source]")?.getAttribute("data-room-source") ?? null]; });
    expect(got.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["Notes", "🦊", "--av:#d97757;--av-ink:#111111", null],
      ["Old", "O", "", null],
      ["Planner", "P", "--av:#1a2b6d;--av-ink:#ffffff", null],
    ]);
    expect(got).toHaveLength(3);
    // Only the neutral avatar (no look) is ringed.
    expect(rows.map((b) => [b.querySelector(".hub-member-name").textContent.trim(), b.querySelector(".hub-agent-av").classList.contains("neutral")]).sort()).toEqual([["Notes", false], ["Old", true], ["Planner", false]]);
    // The source is still said, in each row's title and accessible name (a personal agent's apart from a Fleet's).
    const titles = Object.fromEntries(rows.map((b) => [b.querySelector(".hub-member-name").textContent.trim(), b.getAttribute("title")]));
    expect(titles.Old).not.toBe(titles.Notes);
    expect(rows.every((b) => (b.getAttribute("aria-label") || "").includes(b.getAttribute("title") || "\u0000"))).toBe(true);
  });

  it.each([[false], [true]])("an accepted 64-byte emoji label (16 emoji) never fills the disc: the initial, in one line (compact %s)", async (compact) => {
    const p = page(); mounted.push(p);
    const client = clientModule.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    await p.mount(h(panel.RoomMembersPanel, { client, roomId: "r", detail: detail([agent("e1", "Notes", { look: { color: "#d97757", emoji: "🦊".repeat(16) } })]), compact })); await settle(20);
    if (compact) for (const d of [...p.root.querySelectorAll("details")] as any[]) { d.setAttribute("open", ""); d.open = true; }
    await settle(5);
    const av = p.root.querySelector(".hub-member-agent .hub-agent-av") as any;
    expect([av.getAttribute("data-av"), av.classList.contains("emoji")]).toEqual(["N", false]);
  });

  it.each([["en"], ["zh-TW"]])("the room assistant's row has the sidebar's 「Hub 助理」 disc, H, so the column lines up (%s)", async (lang) => {
    i18n.setLang(lang, { store: false });
    const p = page(); mounted.push(p);
    const client = clientModule.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    await p.mount(h(panel.RoomMembersPanel, { client, roomId: "r", detail: detail([agent("e1", "Notes"), { id: "assistant", kind: "assistant", name: "x", presence: "idle" }]), compact: false })); await settle(20);
    const av = p.root.querySelector(".hub-member-assistant .hub-agent-av") as any;
    expect([av?.getAttribute("data-av"), av?.classList.contains("neutral"), p.root.querySelector(".hub-member-assistant [data-room-source]")]).toEqual(["H", true, null]);
  });

  it("two agents of one name keep one order whatever the room's order: by owner's name, then id (classic and compact)", async () => {
    const twins = [agent("e9", "Atlas", { owner: { id: "o2", name: "Example owner" } }), agent("e1", "Atlas", { owner: { id: "o1", name: "Alex Sample" } }),
      agent("e5", "Atlas", { owner: { id: "o1", name: "Alex Sample" } })];
    const owners = (list: any[]) => list.map((m) => `${m.owner.name}/${m.id}`);
    const want = ["Alex Sample/e1", "Alex Sample/e5", "Example owner/e9"];
    for (const order of [twins, [...twins].reverse(), [twins[1], twins[0], twins[2]]]) expect(owners(presence.sortAgents(order))).toEqual(want);
    for (const compact of [false, true]) {
      const seen: string[][] = [];
      for (const order of [twins, [...twins].reverse()]) {
        const p = page();
        try {
          const client = clientModule.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
          await p.mount(h(panel.RoomMembersPanel, { client, roomId: "r", detail: detail(order), compact })); await settle(20);
          if (compact) for (const d of [...p.root.querySelectorAll("details")] as any[]) { d.setAttribute("open", ""); d.open = true; }
          await settle(5);
          seen.push([...p.root.querySelectorAll(".hub-member-agent .hub-member-open")].map((b: any) => b.getAttribute("title") || ""));
        } finally { await p.unmount(); p.restore(); }
      }
      expect(seen[1]).toEqual(seen[0]);
    }
  });
});

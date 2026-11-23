/**
 * M-3533 R2a: a room's agents in the member list wear their owner's look — the persona emoji, else the initial, on the
 * identity colour (else the default tint) — in the source mark's slot, with no badge (every agent's was the same logo);
 * the row's text is still the name, the source in its title, accessible name and card. Classic and compact lists alike.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

let panel: any, i18n: any, clientModule: any;
const mounted: AppPage[] = [];
beforeAll(async () => { const p = page(); panel = await import("/ui/js/hub-room-members.js"); i18n = await import("/assets/app-i18n.js"); clientModule = await import("/ui/js/hub-client.js"); p.restore(); });
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
    const got = rows.map((b) => { const av = b.querySelector(".hub-agent-av"); return [b.querySelector(".hub-member-name").textContent.trim(), av.getAttribute("data-av"), (av.style?.cssText || av.getAttribute("style") || "").replace(/\s+/g, ""), b.querySelector("[data-room-source]")?.getAttribute("data-room-source") ?? null]; });
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
});

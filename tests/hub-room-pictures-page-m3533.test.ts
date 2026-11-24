/**
 * M-3533 R2b (page): in a room, an agent's disc is the picture its owner's sidebar shows, filling the circle and cropped,
 * never stretched (an agent with none, or one that fails to load, keeps R2a's emoji or initial); its office card draws its
 * identity-card picture where the figure was. The picture's address is the room's own, for its members, by its hash.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let panel: any, clientModule: any, presence: any, card: any, i18n: any;
const mounted: AppPage[] = [];
const g = globalThis as any, realImage = g.Image;
beforeAll(async () => { const p = page(); panel = await import("/ui/js/hub-room-members.js"); clientModule = await import("/ui/js/hub-client.js");
  presence = await import("/ui/js/hub-room-presence.js"); card = await import("/ui/js/fleet-office-card.js"); i18n = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } g.Image = realImage; i18n.setLang("en", { store: false }); });

const HASH = "a".repeat(64);
const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, kind: "agent", name, role: "member", presence: "idle", owner: { name: "Alex" }, ...extra });
const detail = (members: unknown[]) => ({ room: { id: "room-1", kind: "group", name: "Room" }, me: { id: "me", role: "member" }, settings: {}, invited: [],
  members: [{ id: "me", kind: "person", name: "Me", role: "member", presence: "online", signedIn: true }, ...members] });

describe("M-3533 R2b: an agent's picture in a room", () => {
  it("the address: the room's, the agent's, the slot, the hash shown; none without a hash", () => {
    expect(presence.agentPictureSrc("room-1", "exp-1", "disc", HASH)).toBe(`/hub/v1/rooms/room-1/agents/exp-1/picture/disc?v=${HASH}`);
    expect(presence.agentPictureSrc("room 1", "exp/1", "portrait", HASH)).toBe(`/hub/v1/rooms/room%201/agents/exp%2F1/picture/portrait?v=${HASH}`);
    for (const bad of [undefined, "", "abc", "A".repeat(64)]) expect(presence.agentPictureSrc("room-1", "exp-1", "disc", bad)).toBe(null);
    expect(presence.agentPictureSrc(null, "exp-1", "disc", HASH)).toBe(null);
  });

  it.each([[false], [true]])("the disc: the picture where there is one; R2a's emoji or initial where not, or when it fails (compact %s)", async (compact) => {
    const p = page(); mounted.push(p);
    const client = clientModule.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    const members = [agent("e1", "Notes", { look: { color: "#d97757", emoji: "🦊", disc: HASH } }), agent("e2", "Planner", { look: { color: "#1a2b6d" } })];
    await p.mount(h(panel.RoomMembersPanel, { client, roomId: "room-1", detail: detail(members), compact })); await settle(20);
    if (compact) for (const d of [...p.root.querySelectorAll("details")] as any[]) { d.setAttribute("open", ""); d.open = true; }
    await settle(5);
    const av = (name: string) => ([...p.root.querySelectorAll(".hub-member-agent .hub-member-open")] as any[]).find((b) => b.querySelector(".hub-member-name").textContent.trim() === name).querySelector(".hub-agent-av");
    const notes = av("Notes"), img = notes.querySelector("img");
    expect([notes.classList.contains("pic"), img?.getAttribute("src"), img?.getAttribute("alt"), notes.getAttribute("aria-hidden")])
      .toEqual([true, `/hub/v1/rooms/room-1/agents/e1/picture/disc?v=${HASH}`, "", "true"]);
    expect([av("Planner").classList.contains("pic"), av("Planner").getAttribute("data-av"), av("Planner").querySelector("img")]).toEqual([false, "P", null]);
    fire(img, "error"); await settle(5);
    expect([av("Notes").classList.contains("pic"), av("Notes").getAttribute("data-av"), av("Notes").querySelector("img")]).toEqual([false, "🦊", null]);
  });

  it("the disc's picture fills the circle, cropped (object-fit: cover), with no initial over it", () => {
    const css = readFileSync("src/ui/shared/hub-rooms-u2.css", "utf8");
    expect(css).toMatch(/\.hub-agent-av\.pic img \{[^}]*width: 100%; height: 100%; object-fit: cover; border-radius: 50%;/);
    expect(css).toMatch(/\.hub-agent-av\.pic::before \{ content: none; \}/);
  });

  it("the office card draws its photo where the figure was, cropped as the pack portrait; the figure until it loads", async () => {
    const made: any[] = [];
    g.Image = class { onload: any = null; src = ""; naturalWidth = 256; naturalHeight = 256; constructor() { made.push(this); } };
    const p = page(); mounted.push(p);
    let figures = 0;
    const model = { title: "Notes", rows: [], sections: [] } as any;
    await p.mount(h(card.OfficeCard, { model: card.cardModel ? card.cardModel({ node: { name: "n", display_name: "Notes", status: "running", execution_state: "idle" }, lv: () => 1, levels: null, share: true, rows: [], display: "Notes", state: "Idle", now: "", where: "" }) : model,
      avatar: () => { figures++; }, sheet: false, place: () => {}, onFind: () => {}, onClose: () => {}, photo: "/hub/v1/rooms/room-1/agents/e1/picture/portrait?v=" + HASH }));
    await settle(5);
    expect(made.map((m) => m.src)).toEqual([`/hub/v1/rooms/room-1/agents/e1/picture/portrait?v=${HASH}`]);
    expect(figures, "the figure while it loads").toBeGreaterThan(0);
    const cv = p.root.querySelector(".oo-card-avatar canvas") as any, drawn: any[] = [];
    cv.getContext = () => ({ setTransform() {}, clearRect() {}, drawImage: (...a: any[]) => drawn.push(a), set imageSmoothingEnabled(_v: boolean) {} });
    const before = figures;
    made[0].onload(); await settle(5);
    expect(drawn.length, "drawn once loaded").toBeGreaterThan(0);
    expect(drawn.at(-1)[0]).toBe(made[0]);
    expect(drawn.at(-1).slice(1, 5), "the whole square of a square picture").toEqual([0, 0, 256, 256]);
    expect(figures, "no figure over it").toBe(before);
  });
});

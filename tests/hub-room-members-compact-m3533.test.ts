/**
 * M-3533 M1 (docs/design/hub-office-visit.md §2.6): a large room's compact member list — over COMPACT_OVER people and
 * agents together: one summary line, a filter (a name or an owner), one line a row (an agent's owner and introduction in
 * its card), the people not online folded, the agents grouped by owner (folded). A smaller room keeps today's list.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let clientModule: any, panel: any, i18n: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/hub-room-members.js"); i18n = await import("/assets/app-i18n.js");
  pg.restore();
});
afterEach(async () => {
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
  (globalThis as any).EventSource = realEventSource; i18n.setLang("en", { store: false });
});
async function mount(lang: "en" | "zh-TW" = "zh-TW", trim = 0) {
  const fx = createHubRoomsFixture(), pg = page({ url: "http://127.0.0.1:19443/ui/hub" }); mounted.push(pg);
  (globalThis as any).EventSource = fx.EventSource; i18n.setLang(lang, { store: false });
  const client = clientModule.createHubWebClient({ fetchImpl: (path: string, init: any = {}) => fx.fetch(path, init) }); await client.session();
  const d = await client.room("room-weekly");
  let members = d.members;
  if (trim) { let n = 0; members = members.filter((m: any) => m.kind !== "agent" && m.kind !== "later" || ++n <= trim); }
  const detail = { room: d.room, me: { ...d.me, id: FIXTURE_ME.id }, members, settings: d.settings, invited: d.invited };
  await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail })); await settle(20);
  return pg;
}
const q = (pg: AppPage, s: string) => pg.root.querySelector(s) as any;
const all = (pg: AppPage, s: string) => [...pg.root.querySelectorAll(s)] as any[];
const type = async (pg: AppPage, text: string) => { const el = q(pg, ".hub-members-filter"); el.value = text; fire(el, "input"); await settle(5); };
const groups = (pg: AppPage) => all(pg, ".hub-member-group").map((g) => [g.querySelector("summary").textContent, !!(g.open || g.hasAttribute("open")), [...g.querySelectorAll(".hub-member-name")].map((n: any) => n.textContent)]);

describe("the compact member list (M-3533 M1)", () => {
  it("a room over 12: the summary, the filter, online people, the rest folded, agents by owner folded, one line a row", async () => {
    const pg = await mount("zh-TW");
    expect(q(pg, ".hub-room-members").classList.contains("compact")).toBe(true);
    expect(q(pg, ".hub-members-sum").textContent).toBe("3 人，2 人在線上 · 12 個 Agent，3 位擁有者");
    expect([q(pg, ".hub-members-filter").getAttribute("placeholder"), q(pg, ".hub-members-filter").getAttribute("aria-label")]).toEqual(["篩選：名稱或擁有者", "篩選成員"]);
    // The headings keep the room's counts.
    expect(all(pg, ".hub-room-members h4").map((x) => x.textContent)).toEqual(["成員 · 3（線上 2）", "Agent · 12（線上 7）", "誰看得到"]);
    // Online people (me first) in the open; the others folded.
    const open = all(pg, ".hub-members-people > ul > .hub-member").map((li) => li.querySelector(".hub-member-name").textContent);
    expect(open).toEqual(["王經理 你 管理", "陳主任"]);
    expect(groups(pg)).toEqual([
      ["不在線上 · 1", false, ["吳小安"]],
      ["吳小安 · 4", false, ["budget-check", "release-notes", "infra-watch", "report-bot"]],
      ["林小華 · 4", false, ["project-helper", "design-review", "test-runner", "old-helper"]],
      ["陳主任 · 4", false, ["doc-search", "spec-writer", "schedule-bot", "desk-notes"]],
    ]);
    // One line a row: no owner beside an agent's state and no introduction under it; both are in its card.
    expect([all(pg, ".hub-member-agent .hub-member-owner").length, all(pg, ".hub-member-agent .hub-member-open small.note").length]).toEqual([0, 0]);
    fire(all(pg, ".hub-member-agent .hub-member-open").find((b) => b.querySelector(".hub-member-name").textContent === "budget-check"), "click"); await settle(5);
    expect(q(pg, ".hub-member-card").textContent).toContain("擁有者：吳小安");
    // The assistant, who sees what and Room settings stay as they are.
    expect([!!q(pg, ".hub-member-assistant"), !!q(pg, ".hub-room-who")]).toEqual([true, true]);
  });
  it("the filter: a name or an owner, any case; groups with a match open and show only matches; the counts stay; none says so", async () => {
    const pg = await mount("zh-TW");
    await type(pg, "林小華");
    expect(groups(pg)).toEqual([["林小華 · 4", true, ["project-helper", "design-review", "test-runner", "old-helper"]]]);
    expect(all(pg, ".hub-members-people > ul > .hub-member")).toEqual([]);
    await type(pg, "REPORT");
    // While a filter is on, a group's number is the rows under it (as 「不在線上」's); the summary and headings keep the room's.
    expect(groups(pg)).toEqual([["吳小安 · 1", true, ["report-bot"]]]);
    await type(pg, "吳");
    expect(groups(pg).map((g) => [g[0], g[1]])).toEqual([["不在線上 · 1", true], ["吳小安 · 4", true]]);
    expect(q(pg, ".hub-members-sum").textContent).toBe("3 人，2 人在線上 · 12 個 Agent，3 位擁有者");
    // While filtering the headings say how many match of how many; cleared, they are the room's again.
    expect(all(pg, ".hub-room-members h4").map((x) => x.textContent).slice(0, 2)).toEqual(["成員 · 符合 1／3", "Agent · 符合 4／12"]);
    await type(pg, "nobody-here");
    expect([groups(pg), q(pg, ".hub-members-none")?.textContent]).toEqual([[], "沒有符合的成員。"]);
    await type(pg, "");
    expect(groups(pg).every((g) => g[1] === false)).toBe(true);
    expect(all(pg, ".hub-room-members h4").map((x) => x.textContent).slice(0, 2)).toEqual(["成員 · 3（線上 2）", "Agent · 12（線上 7）"]);
  });
  it("en", async () => {
    const pg = await mount("en");
    expect(q(pg, ".hub-members-sum").textContent).toBe("3 people, 2 online · 12 agents of 3 owners");
    expect(q(pg, ".hub-members-filter").getAttribute("placeholder")).toBe("Filter: name or owner");
    expect(groups(pg)[0][0]).toBe("Not online · 1");
    await type(pg, "report");
    expect(all(pg, ".hub-room-members h4").map((x) => x.textContent).slice(0, 2)).toEqual(["Members · 0 of 3 match", "Agents · 1 of 12 match"]);
  });
  it("12 or fewer people and agents: today's list (no summary, no filter, no groups)", async () => {
    const pg = await mount("zh-TW", 9);   // 3 people + 9 agents
    expect([q(pg, ".hub-room-members").classList.contains("compact"), !!q(pg, ".hub-members-filter"), all(pg, ".hub-member-group").length, all(pg, ".hub-member-agent .hub-member-owner").length > 0])
      .toEqual([false, false, 0, true]);
  });
  it("on a touch screen the filter, the folds and an agent's row are a fingertip (--tap) high", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/hub-rooms-u2.css"), "utf8");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([^@]*?)\}\s*\}/g)].map((m) => m[1]).join("\n");
    for (const sel of [".hub-room-members .hub-members-filter", ".hub-member-group > summary", ".hub-room-members.compact .hub-member-open"]) {
      const rule = coarse.split("}").find((r) => r.includes(sel));
      expect([sel, /min-height:\s*var\(--tap\)/.test(rule || "")]).toEqual([sel, true]);
    }
    expect(css).toMatch(/--tap/);
    // The placeholder in the dashboard's placeholder colour (≥ 4.5:1 in dark and light), never the browser's faint grey.
    expect(css).toMatch(/\.hub-members-filter::placeholder\s*\{\s*color:\s*var\(--text-3\);\s*opacity:\s*1;/);
  });
  it("byOwner, peopleOrder and memberMatches (pure): my group first, owners by name, keyed by id; people me first, by name", () => {
    const a = (name: string, owner: string, id?: string, mine?: boolean) => ({ name, owner: { name: owner, ...(id ? { id } : {}), ...(mine ? { mine: true } : {}) } });
    expect(panel.byOwner([a("x", "B"), a("y", "A"), a("z", "B")]).map((g: any) => [g.owner, g.agents.map((m: any) => m.name)])).toEqual([["A", ["y"]], ["B", ["x", "z"]]]);
    // Two owners of one name are two groups; mine leads whatever its name.
    const g = panel.byOwner([a("x", "Alex", "corp/1"), a("y", "Alex", "corp/2"), a("z", "Zed", "corp/me", true)]);
    expect(g.map((x: any) => [x.owner, x.key, x.agents.map((m: any) => m.name)])).toEqual([["Zed", "corp/me", ["z"]], ["Alex", "corp/1", ["x"]], ["Alex", "corp/2", ["y"]]]);
    const p = (id: string, name: string) => ({ id, name });
    expect(panel.peopleOrder([p("3", "Casey"), p("1", "Alex"), p("me", "Zed"), p("0", "Alex")], "me", "en").map((x: any) => x.id)).toEqual(["me", "0", "1", "3"]);
    expect([panel.memberMatches(a("Notes", "Alex Sample"), "alex"), panel.memberMatches(a("Notes", "Alex"), "NOT"), panel.memberMatches(a("Notes", "Alex"), "zzz"), panel.memberMatches(a("Notes", ""), "  ")]).toEqual([true, true, false, true]);
  });
});

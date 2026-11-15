/**
 * M-3145 (docs/design/hub-fleet-versions.md §4.4; contract M-3144): a Fleet's Notices entry about an update the Hub's
 * administrator asked for (WebNotice kind "update" with hubUpdate) says, in the owner's words, what happened by state;
 * its actions (Update now / Cancel update / the full log) are offered by state and drawn only when the page gives them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let m: any, words: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); m = await import("/ui/js/notice-hub-update.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } });
const hu = (state: string, over: Record<string, unknown> = {}) => ({ requestId: "rq1", hubName: "Team Hub", requestedBy: { name: "Ada" }, version: "2.4.0", state, ...over });

describe("the owner's words, by state", () => {
  it("en and zh-TW, the Hub, who asked and the versions named", () => {
    words.setLang("en");
    expect(["waiting", "done", "rolled-back", "expired", "cancelled", "failed"].map((s) => m.hubUpdateNoticeText(hu(s, { currentVersion: "2.3.9" })))).toEqual([
      "Ada (Team Hub) asked to update this Fleet to AgEnD v2.4.0. It will start when your agents are idle.",
      "AgEnD is updated to v2.4.0, as Ada (Team Hub) asked.",
      "The update to v2.4.0 did not work. AgEnD is back on v2.3.9; nothing else changed.",
      "The update Ada (Team Hub) asked for did not start: your agents were busy for 24 hours. You can update from here when ready.",
      "Update cancelled. Ada (Team Hub) has been told.",
      "The update to v2.4.0 that Ada (Team Hub) asked for did not finish."]);
    words.setLang("zh-TW");
    expect(m.hubUpdateNoticeText(hu("waiting"))).toBe("Ada（Team Hub）要求把這個 Fleet 更新到 AgEnD v2.4.0。會等你的 Agent 都閒置才開始。");
    expect(m.hubUpdateNoticeText(hu("unknown-state"))).toBeNull();
  });

  it("the actions a state offers", () => {
    expect(["waiting", "expired", "rolled-back", "done", "cancelled"].map((s) => m.hubUpdateNoticeActions(hu(s))))
      .toEqual([["updateNow", "cancelUpdate"], ["updateNow"], ["fullLog"], [], []]);
  });
});

describe("the notice's body", () => {
  it("with the page's actions: Update now / Cancel update, bound to the request; without them: the words alone; not ours: its text", async () => {
    const p = page({ storage: { agend_lang: "en" } }); pages.push(p); words.setLang("en");
    const updateNow = vi.fn(), cancelUpdate = vi.fn();
    await p.mount(h("div", {},
      h("div", { class: "a" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "plain", hubUpdate: hu("waiting") }, actions: { updateNow, cancelUpdate } })),
      h("div", { class: "b" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "plain", hubUpdate: hu("waiting") } })),
      h("div", { class: "c" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "AgEnD 2.4.1 is available." } }))));
    await settle(3);
    const buttons = [...p.root.querySelectorAll(".a button")] as any[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Update now", "Cancel update"]);
    fire(buttons[1], "click");
    expect(cancelUpdate).toHaveBeenCalledWith("rq1");
    expect([p.root.querySelector(".b button"), p.root.querySelector(".c .notice-text").textContent]).toEqual([null, "AgEnD 2.4.1 is available."]);
  });
});

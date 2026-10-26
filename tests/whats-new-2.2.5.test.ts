/**
 * 2.2.5 stable is published from a 2.3.0 beta's SHA (the user's decision, 2026-10-19). Its agents' what's-new entries
 * carry `since: "2.2.5"`: a 2.2.x install upgrading to 2.2.5 is told them once, a 2.3.0 beta that was already told them
 * (the record is by id) is not told again, and a later 2.3.0 tells only what came after.
 */
import { describe, expect, it } from "vitest";
import { AGENT_WHATS_NEW, compareVersions, planWhatsNew, type WhatsNewEntry } from "../src/agent-whats-new.js";

const idsUpTo = (version: string, entries: readonly WhatsNewEntry[] = AGENT_WHATS_NEW) =>
  entries.filter(e => compareVersions(e.since, version)! <= 0).map(e => e.id);
const planned = (p: ReturnType<typeof planWhatsNew>): string[] | null => (p && "ids" in p ? p.ids : null);
const NEW_IN_225 = AGENT_WHATS_NEW.filter(e => e.id.startsWith("2.3-")).map(e => e.id);

describe("what's new for agents, upgrading to and from 2.2.5", () => {
  it("2.2.1 → 2.2.5: told every 2.2.5 entry once, then nothing", () => {
    const on221 = idsUpTo("2.2.1");
    expect(on221.some(id => id.startsWith("2.3-")), "a 2.2.1 install knew none of them").toBe(false);
    const plan = planWhatsNew({ record: { announced: on221 }, fresh: false, version: "2.2.5" });
    expect(plan && "notice" in plan, "a notice, not a silent record").toBe(true);
    expect(planned(plan)).toEqual(NEW_IN_225);
    expect(NEW_IN_225.length).toBeGreaterThan(0);
    expect(planWhatsNew({ record: { announced: [...on221, ...planned(plan)!] }, fresh: false, version: "2.2.5" }), "told once").toBeNull();
  });

  it("2.3.0-beta.11 → 2.3.0-beta.12: an instance already told (by id) is not told again", () => {
    // On beta.11 the same ids were told under their beta `since`; the record keeps ids, not versions.
    const toldOnBeta11 = AGENT_WHATS_NEW.map(e => e.id);
    expect(planWhatsNew({ record: { announced: toldOnBeta11 }, fresh: false, version: "2.3.0-beta.12" })).toBeNull();
  });

  it("2.2.5 / 2.2.6 → 2.3.0: only the entries added after 2.2.5 (the 2.3.0 ones), once", () => {
    const toldOn225 = idsUpTo("2.2.5");
    const NEW_IN_230 = AGENT_WHATS_NEW.filter(e => e.since === "2.3.0").map(e => e.id);
    expect(NEW_IN_230).toEqual(["2.3.0-task-board", "2.3.0-web-reply-react", "2.3.0-dashboard-switches", "2.3.0-cli"]);
    for (const version of ["2.2.6", "2.3.0-beta.26"]) {
      expect(planned(planWhatsNew({ record: { announced: toldOn225 }, fresh: false, version })), `${version}: nothing yet`).toBeNull();
    }
    const plan = planWhatsNew({ record: { announced: toldOn225 }, fresh: false, version: "2.3.0" });
    expect(planned(plan)).toEqual(NEW_IN_230);
    expect(planWhatsNew({ record: { announced: [...toldOn225, ...NEW_IN_230] }, fresh: false, version: "2.3.0" }), "told once").toBeNull();
  });
  it("2.3.0: the CLI entry is for General and coordinators; a worker records it as known, never shown", () => {
    const toldOn225 = idsUpTo("2.2.5");
    const notice = (audience: "general" | "worker") => { const p = planWhatsNew({ record: { announced: toldOn225 }, fresh: false, version: "2.3.0", roles: [audience] }); return p && "notice" in p ? p.notice : ""; };
    expect([notice("general").includes("`agend restart`"), notice("worker").includes("`agend restart`"), notice("worker").includes("Task board")]).toEqual([true, false, true]);
  });

  it("a fresh 2.2.5 install is told nothing: everything is recorded as known", () => {
    const plan = planWhatsNew({ record: null, fresh: true, version: "2.2.5" });
    expect(plan && "silent" in plan ? plan.silent : plan).toEqual(idsUpTo("2.2.5"));
  });

  it("every entry after 2.2.5 is for 2.3.0 stable (a beta `since` would hide it from a 2.2.x install updating to 2.3.0), or after 2.3.1", () => {
    // 2.3.0 and 2.3.1 have shipped: a later entry may name the beta that brings it (#2692: 2.3.2-beta.11) — newer than
    // every published stable, so an install on any of them is told on its update. Never one between 2.2.5 and 2.3.1.
    expect(AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.5")! > 0 && e.since !== "2.3.0" && compareVersions(e.since, "2.3.1")! <= 0).map(e => `${e.id} (${e.since})`)).toEqual([]);
  });
});

// 2.3.0 (#2275): Canvas Worker effects are experimental — off unless the person turns them on — never announced as stable,
// and never as "still beta" any more.
describe("Canvas Worker effects are announced as experimental", () => {
  const CW = /Canvas Worker|upload_web_effect|apply_web_effect/;
  it("every entry that names Canvas Worker effects or their tools says they are experimental and off unless turned on", () => {
    const named = AGENT_WHATS_NEW.filter(x => CW.test(x.text));
    expect(named.map(e => e.id), "the entries that name them (the check below runs on each)").toEqual(["2.3-web-appearance-topic", "2.3-web-settings-for-the-user"]);
    for (const e of named) expect([/experimental — off unless the person turns them on/.test(e.text), /still beta/.test(e.text)], e.id).toEqual([true, false]);
  });
  it("the enabled 2.2.1 → 2.3.0 notice calls them experimental, never stable or beta", () => {
    const plan = planWhatsNew({ record: { announced: idsUpTo("2.2.1") }, fresh: false, version: "2.3.0", canvasWorker: true });
    const notice = plan && "notice" in plan ? plan.notice : "";
    expect(notice).toContain("AgEnD is now 2.3.0");
    const lines = notice.split("\n").filter(l => /Canvas Worker/.test(l));
    expect(lines.length, "both lines that name them are in the notice").toBe(2);
    for (const line of lines) expect([/experimental/.test(line), /still beta|stable/.test(line)]).toEqual([true, false]);
  });
});

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

  it("2.2.5 → 2.3.0: only the entries added after 2.2.5", () => {
    const later: WhatsNewEntry = { id: "2.3-after-225", since: "2.3.0-beta.13", text: "Something new after 2.2.5." };
    const entries = [...AGENT_WHATS_NEW, later];
    const toldOn225 = idsUpTo("2.2.5", entries);
    expect(toldOn225).not.toContain(later.id);
    expect(planned(planWhatsNew({ record: { announced: toldOn225 }, fresh: false, version: "2.3.0", entries }))).toEqual([later.id]);
  });

  it("a fresh 2.2.5 install is told nothing: everything is recorded as known", () => {
    const plan = planWhatsNew({ record: null, fresh: true, version: "2.2.5" });
    expect(plan && "silent" in plan ? plan.silent : plan).toEqual(idsUpTo("2.2.5"));
  });

  it("until 2.2.5 is cut, every entry reaches 2.2.5 (a beta `since` would hide it from every 2.2.5 install)", () => {
    // After 2.2.5 has shipped, entries for later versions are expected: update or drop this check then.
    expect(AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.5")! > 0).map(e => `${e.id} (${e.since})`)).toEqual([]);
  });
});

describe("Canvas Worker effects stay beta in what a 2.2.5 install is told", () => {
  const CW = /Canvas Worker|upload_web_effect|apply_web_effect/;
  it("every entry that names Canvas Worker effects or their tools says they are still beta", () => {
    const named = AGENT_WHATS_NEW.filter(x => compareVersions(x.since, "2.2.5")! <= 0 && CW.test(x.text));
    expect(named.map(e => e.id), "the entries that name them (the check below runs on each)").toEqual(["2.3-web-appearance-topic", "2.3-web-settings-for-the-user"]);
    for (const e of named) expect(e.text, e.id).toMatch(/still beta/);
  });
  it("the enabled 2.2.1 → 2.2.5 notice never announces them as stable", () => {
    const plan = planWhatsNew({ record: { announced: idsUpTo("2.2.1") }, fresh: false, version: "2.2.5", canvasWorker: true });
    const notice = plan && "notice" in plan ? plan.notice : "";
    expect(notice).toContain("AgEnD is now 2.2.5");
    const lines = notice.split("\n").filter(l => /Canvas Worker/.test(l));
    expect(lines.length, "both lines that name them are in the notice").toBe(2);
    for (const line of lines) expect(line).toMatch(/still beta \(2\.3\)/);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { page } from "./helpers/app-harness.js";

let words: any;
beforeAll(async () => {
  const p = page();
  try {
    words = await import("/assets/app-i18n.js");
    await import("/ui/js/hub-strings.js");
    await import("/ui/js/hub-quick-strings.js");
    await import("/ui/js/hub-owner-strings.js");
    await import("/ui/js/settings-hub-membership.js");
  } finally { p.restore(); }
});

describe.each(["en", "zh-TW"])("Hub pairing instructions match the fleet's labels (%s)", language => {
  const text = (key: string) => words.tIn(language, key);
  it("names the actual fleet pending card in the comparison path", () => {
    expect(text("hubQuick.compare")).toContain(`→ ${text("hub.pendingTitle")}`);
  });
  it.each(["hubQuick.address", "hubOwner.memberAddress"])("%s uses the fleet address field label", key => {
    expect(text(key)).toBe(text("hub.address"));
  });
  it.each(["hubQuick.local", "hubOwner.memberAddressHint", "hubOwner.memberAddressMissing"])("%s points to the same address field", key => {
    expect(text(key)).toContain(text("hub.address"));
  });
  // The leader's cid-hub-no-reload (Fable's note on #3412): the step names the fleet's own membership switch, as labelled —
  // and no reload step (turning it on shows the pairing fields in place).
  it("hubQuick.local names the membership switch by its label, and asks for no reload", () => {
    expect(text("hubQuick.local")).toContain(text("hubMembership.enabled"));
    expect(text("hubQuick.local")).not.toMatch(/reload|重新整理/i);
  });
});

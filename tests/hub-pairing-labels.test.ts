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
});

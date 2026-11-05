/**
 * S-51 (S5b PR 2): a held Hub is one Needs-you item per side, on S4's "hub" item type, with why in the fleet's
 * language. Display-only; never on the public link (web-api excludes every "hub" item).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deriveNeedsYou, renderSignature } from "../src/needs-you.js";
import { HUB_HOLD_CODES } from "../src/hub/db.js";
import { setLocale, t } from "../src/locale.js";

const base = { prompts: [], instances: [], deliveries: [], ownerOf: () => undefined };

describe("Hub holds in Needs you (S-51)", () => {
  it("each held side is one display-only item with its reason and detail; none while running", () => {
    expect(deriveNeedsYou({ ...base, hubHolds: [] }).filter((i) => i.type === "hub")).toEqual([]);
    const items = deriveNeedsYou({
      ...base,
      hubHolds: [
        { side: "server", code: "hub-incomplete", detail: "not every part yet", since: 10 },
        { side: "member", code: "hub-member-pairing", detail: "pair again", since: 20 },
      ],
    });
    expect(items.filter((i) => i.reason === "hub_unavailable")).toEqual([
      { id: "hub-hold:server:hub-incomplete:10", type: "hub", instance: "", reason: "hub_unavailable", detail: "not every part yet", since: 10 },
      { id: "hub-hold:member:hub-member-pairing:20", type: "hub", instance: "", reason: "hub_unavailable", detail: "pair again", since: 20 },
    ]);
    const before = renderSignature(items, 100);
    const after = renderSignature(deriveNeedsYou({ ...base, hubHolds: [{ side: "server", code: "hub-unsealed", detail: "x", since: 30 }] }), 100);
    expect(after).not.toBe(before);
  });

  it("every hold code has fleet text in both languages, and the reason has a label on the web", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      expect(t("needs.reason.hub_unavailable")).not.toBe("needs.reason.hub_unavailable");
      for (const code of HUB_HOLD_CODES) expect(t(`hub.hold.${code}`), `${locale} ${code}`).not.toBe(`hub.hold.${code}`);
    }
    setLocale("en");
    for (const file of ["src/ui/shared/app-i18n.js", "src/ui/panel-needs.js"]) {
      expect((readFileSync(file, "utf8").match(/needs_reason_hub_unavailable:/g) ?? []).length, file).toBe(2);
    }
  });

  it("the public link never carries a hub item", () => {
    expect(readFileSync("src/web-api.ts", "utf8")).toMatch(/item\.type === "config" \|\| item\.type === "hub"\) return false/);
  });
});

/**
 * M-3695: every word the Office's modules look up is registered by a module the Hub and the share page actually serve.
 * The room office announced its zoom buttons as 'orgc.zoomIn' / 'orgc.zoomOut': those words lived in the org chart
 * canvas (fleet-canvas.js), which the Fleet dashboard loads and the Hub (HUB_OFFICE_MODULES) and share page do not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARE_MODULES } from "../src/office-share-page.js";
import { HUB_OFFICE_MODULES, HUB_UI_MODULES } from "../src/hub/http/compose.js";

const UI = join(process.cwd(), "src", "ui");
const src = (f: string) => readFileSync(join(UI, f), "utf8");
const shared = readdirSync(join(UI, "shared")).filter((f) => f.endsWith(".js")).map((f) => join("shared", f));
const registered = (files: readonly string[]) => new Set(files.flatMap((f) => [...src(f).matchAll(/register\("([A-Za-z]+)"/g)].map((m) => m[1]!)));
/** `t("ns.key")` / t(`ns.${…}`) lookups whose namespace none of `served` registers. */
const missing = (modules: readonly string[], served: readonly string[]) => {
  const ns = registered(served);
  return modules.flatMap((f) => [...src(f).matchAll(/\bt\(\s*[`"']([A-Za-z]+)\.([A-Za-z0-9_]*)/g)].filter((m) => !ns.has(m[1]!)).map((m) => `${f}: ${m[1]}.${m[2]}`));
};

describe("the Office's words travel with it (M-3695)", () => {
  it("the Hub's room office: every namespace it looks up is in HUB_OFFICE_MODULES, the Hub's own modules or the shared assets", () => {
    const hub = [...HUB_OFFICE_MODULES, ...HUB_UI_MODULES.filter((f) => f.startsWith("hub-room-")), "hub-room-office.js"];
    expect(missing(hub, [...hub, ...HUB_UI_MODULES, ...shared])).toEqual([]);
  });
  it("the share page: every namespace it looks up is in SHARE_MODULES or the shared assets", () => {
    expect(missing(SHARE_MODULES, [...SHARE_MODULES, ...shared])).toEqual([]);
  });
});

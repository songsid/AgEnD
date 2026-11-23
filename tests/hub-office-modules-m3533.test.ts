/**
 * M-3533 R1-page: the Hub serves the Office drawing a room's office loads (hub-room-office.js's import()) — every module
 * it imports, followed to the end, is one the Hub serves (HUB_OFFICE_MODULES or the app's public /assets/), and the
 * share link's own page module is not among them. No Hub UI module imports the drawing statically.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { afterEach, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_OFFICE_MODULES, HUB_UI_MODULES } from "../src/hub/http/compose.js";
import { isServedAsset } from "../src/auth-api.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
const ui = (...p: string[]) => join(process.cwd(), "src", "ui", ...p);
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|^import\s*)["']([^"']+\.js)["']/gm)].map(m => m[1]!);

it("serves the drawing's whole closure, and nothing of the share page's own", async () => {
  rig = await s3bRig();
  const seen = new Set<string>(), todo = ["/ui/js/fleet-office.js", "/ui/js/fleet-org.js"];
  while (todo.length) {
    const url = todo.pop()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (url.startsWith("/assets/")) { expect([url, isServedAsset(url.slice(8))]).toEqual([url, true]); continue; }
    const file = url.slice("/ui/js/".length);
    expect([url, HUB_OFFICE_MODULES.includes(file)]).toEqual([url, true]);
    for (const spec of imports(ui(file))) todo.push(spec.startsWith("/") ? spec : posix.join(posix.dirname(url), spec));
  }
  for (const url of [...seen].filter(u => u.startsWith("/ui/js/"))) expect((await rig.call(null, "GET", url)).status, url).toBe(200);
  expect(HUB_OFFICE_MODULES).not.toContain("office-share-page.js");
  expect((await rig.call(null, "GET", "/ui/js/office-share-page.js")).status).not.toBe(200);
});

it("the room page loads the drawing only with import(): no Hub UI module imports it statically", () => {
  for (const f of HUB_UI_MODULES) for (const spec of imports(ui(f))) expect(`${f} → ${spec}`).not.toMatch(/→ \.\/(fleet-|office-share)/);
  expect(readFileSync(ui("hub-room-office.js"), "utf8")).toMatch(/import\("\.\/fleet-office\.js"\)/);
});

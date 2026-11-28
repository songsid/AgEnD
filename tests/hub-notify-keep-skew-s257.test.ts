/**
 * Prism #4548 P2: module skew. A browser tab can still hold the PREVIOUS hub-room-notify.js (cached by URL) when a new
 * hub-room-thread.js arrives. If the room imported a name that file did not export, the whole room module would fail to
 * link. So the room imports nothing new from hub-room-notify.js; the keep-notifications action lives in its own new
 * module (hub-notify-keep.js), which a tab always loads fresh.
 * Node's real ESM linker, in a child process: the RETAINED base hub-room-notify.js (tests/fixtures/skew/
 * hub-room-notify.base-c544873e5.js, the file at release c544873e5) with stub neighbours, and a probe holding exactly
 * the room's current import statement from it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui");
const BASE = join(__dirname, "fixtures", "skew", "hub-room-notify.base-c544873e5.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The room's import statements from a module, exactly as written. */
const importsFrom = (src: string, from: string) => [...src.matchAll(/^import\s*\{[^}]*\}\s*from\s*"([^"]+)";$/gm)].filter((m) => m[1] === from).map((m) => m[0]);

function linkWithRetained(statements: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-skew-s257-")); dirs.push(dir);
  // Stub neighbours: every name the retained file imports exists, doing nothing.
  writeFileSync(join(dir, "app-needs.js"), "export const notifyOn=()=>false, notifySupport=()=>'ok', notifyStore={get:()=>({}),set(){},subscribe(){return()=>{}}}, refreshNotify=()=>{}, setNotify=async()=>'off';");
  writeFileSync(join(dir, "app-html.js"), "export const html=()=>'', useEffect=()=>{};");
  writeFileSync(join(dir, "app-store.js"), "export const useStore=(s)=>s.get();");
  writeFileSync(join(dir, "ui-icons.js"), "export const Icon=()=>'';");
  writeFileSync(join(dir, "hub-room-unread.js"), "export const counts=()=>null, shouldNotify=()=>false;");
  writeFileSync(join(dir, "hub-room-strings.js"), "export const hroom=(k)=>k;");
  writeFileSync(join(dir, "hub-room-notify.js"), readFileSync(BASE, "utf8").replace(/(["'])\/assets\//g, "$1./"));
  writeFileSync(join(dir, "probe.js"), `${statements.join("\n")}\nconsole.log("linked");`);
  // Keep the expected negative-control linker failure in the thrown error,
  // rather than printing error-shaped stderr from a passing test into CI.
  return execFileSync(process.execPath, [pathToFileURL(join(dir, "probe.js")).pathname],
    { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

it("the room's import from hub-room-notify.js links against the RETAINED base file", () => {
  const room = readFileSync(join(UI, "hub-room-thread.js"), "utf8");
  const statements = importsFrom(room, "./hub-room-notify.js");
  expect(statements).toEqual(['import { HubNotifyToggle } from "./hub-room-notify.js";']);
  expect(linkWithRetained(statements)).toBe("linked");
});
it("the control: importing the new action from the retained file fails to link (what the room must not do)", () => {
  expect(() => linkWithRetained(['import { setHubNotify } from "./hub-room-notify.js";'])).toThrow(/setHubNotify/);
});
it("the action and its words are in a new module the Hub serves", () => {
  expect(readFileSync(join(UI, "hub-room-thread.js"), "utf8")).toContain('import { setHubNotify } from "./hub-notify-keep.js";');
  expect(readFileSync(join(UI, "hub-notify-keep.js"), "utf8")).toMatch(/register\("hubkeep"/);
  expect(readFileSync(join(__dirname, "..", "src", "hub", "http", "compose.ts"), "utf8")).toMatch(/HUB_UI_MODULES = Object\.freeze\(\["panel-hub\.js", "hub-notify-keep\.js"/);
});

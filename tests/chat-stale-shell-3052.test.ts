// #3052 review item 2: the chat panel is loaded on demand, so a tab opened before an upgrade gets the new panel-chat.js
// but keeps the OLD shell modules. The old instance-nav.js has no `machineName`; the panel used to import it from there,
// the import failed, and every chat stayed blank. Here the shell's instance-nav is the old one (no `machineName`, and a
// missing name on a vitest mock throws when it is read), and a chat of an Agent on a paired computer is rendered: the
// path that calls machineName. Putting the old import back makes the render test fail (checked by hand).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

vi.mock("/assets/instance-nav.js", async (original) => {
  const { machineName: _later, ...old } = await original<Record<string, unknown>>();
  return old;
});

let p: AppPage, app: any, chat: any;
const realFetch = globalThis.fetch, listeners = new Map<string, Array<(value: any) => void>>();
const nativeId = "12345678-1234-4321-abcd-123456789012", machineId = "22345678-1234-4321-abcd-123456789012", nativeName = "native-stale";
const nativeRow=()=>({name:nativeName,display_name:"Master",runtime:"windows",native_agent_id:nativeId,status:"running",state:"idle",execution_state:"idle",backend:"codex",model:"gpt-5.5",capabilities:{terminal:false,attachments:false,commands:false,usage:false,lifecycle:true,send_while_busy:false}});
const emit = (event: string, value: any) => { for (const listener of listeners.get(event) || []) listener(value); };
const fetchFake = async () => ({ ok: true, status: 200, json: async () => ({}) });
beforeAll(async () => {
  p = page({ url: "http://localhost/ui", storage: { agend_lang: "en", agend_tour_done: "1" } });
  globalThis.fetch = fetchFake as any;
  const { setLang } = await import("/assets/app-i18n.js"); setLang("en", { store: false });
  app = await import("/assets/app-store.js"); chat = await import("/ui/js/panel-chat.js");
  chat.boot({ stream: { on(event: string, listener: (value: any) => void) { const rows = listeners.get(event) || []; rows.push(listener); listeners.set(event, rows); return () => {}; } }, boot: null, deps: { fetch: fetchFake } });
});
afterEach(async () => { await p.unmount(); chat.forgetKeptThreads(); });
afterAll(() => { p.restore(); globalThis.fetch = realFetch; });

describe("Chat in a tab opened before the upgrade (stale shell)", () => {
  it("the stale instance-nav really lacks machineName", async () => {
    const nav = await import("/assets/instance-nav.js");
    expect("machineName" in nav).toBe(false);
  });
  it.each([["a named computer", "Build desktop", "Build desktop"], ["a computer with no name yet", undefined, "Computer 22345678"]])("still renders the chat of an Agent on %s, with the computer's name in its header", async (_how, name, shown) => {
    const status = { instances: [{ ...nativeRow(), machine_id: machineId, machine_name: name, machine_status: "online" }], windows_cli: true, uptime: 1 };
    app.applyStatus(status); emit("status", status);
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: nativeName }, navKey: `chat:${nativeName}` })); await settle(8);
    expect(p.root.querySelector(".p-chat")).not.toBeNull();
    expect(p.root.querySelector(".runtime-machine-tag")?.textContent).toBe(shown);
  });
  it("the helper lives in a public shell asset that depends only on the i18n module every old shell already has", () => {
    expect(readFileSync(join(process.cwd(), "src", "auth-api.ts"), "utf8")).toContain('"machine-name.js"');
    const src = readFileSync(join(process.cwd(), "src", "ui", "shared", "machine-name.js"), "utf8");
    expect([...src.matchAll(/^import .* from "(.+)";/gm)].map(m => m[1])).toEqual(["./app-i18n.js"]);
  });
  it("panel-chat.js takes nothing newer than the old shell from instance-nav.js", () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "panel-chat.js"), "utf8");
    const named = /import \{([^}]*)\} from "\/assets\/instance-nav\.js"/.exec(src)![1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]);
    expect(named.sort()).toEqual(["modelText", "namesOf", "namesStore", "navStore", "supportsInstanceFeature"]);
  });
});

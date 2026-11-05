// #3052 review item 2: the chat panel is loaded on demand, so a tab opened before an upgrade gets the new panel-chat.js
// but keeps the OLD shell modules. The old instance-nav.js has no `machineName`; the panel used to import it from there,
// the import failed, and every chat stayed blank. The panel must load with a shell whose instance-nav lacks the new name.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, type AppPage } from "./helpers/app-harness.js";

// The stale shell's instance-nav: every export the new panel-chat has always had, none of the later ones.
vi.mock("/assets/instance-nav.js", async (original) => {
  const { machineName: _later, ...old } = await original<Record<string, unknown>>();
  return old;
});

let p: AppPage;
beforeAll(() => { p = page({ url: "http://localhost/ui/chat/agent-1", storage: { agend_lang: "en" } }); });
afterAll(() => p.restore());

describe("Chat in a tab opened before the upgrade (stale shell)", () => {
  it("the stale instance-nav really lacks machineName", async () => {
    const nav = await import("/assets/instance-nav.js");
    expect("machineName" in nav).toBe(false);
  });
  it("panel-chat.js loads against the stale shell (the guard below is what catches a re-introduced import of a newer name)", async () => {
    const chat = await import("/ui/js/panel-chat.js");
    expect(typeof chat.ChatPanel === "function" || Object.keys(chat).length > 0).toBe(true);
  });
  it("that module is a public shell asset and depends only on the i18n module every old shell already has", () => {
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

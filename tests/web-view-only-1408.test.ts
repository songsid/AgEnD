/**
 * #1408 step 2: the View-only page through the real entry (app.js) in a fake DOM, in a module graph of its own: its
 * nav is View and Sign in, nothing else; it opens no stream; its reads are View's passive ones only; Edit asks to sign in.
 */
import { describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
import { isPassiveWebRead } from "../src/web-auth.js";

const ROSTER = [
  { instance_name: "alpha", display_name: "Alpha", status: "running", context_pct: 40, model: "m1", backend: "codex", tags: ["core"], has_avatar: false, role: "dev", description: "" },
  { instance_name: "beta", display_name: null, status: "stopped", context_pct: null, model: "", backend: "kiro-cli", tags: [], has_avatar: false, role: null, description: "" },
];

describe("the View-only page (the real entry, a fake DOM)", () => {
  it("nav: View and Sign in only; no stream; reads only View's passive endpoints; Edit asks to sign in", async () => {
    vi.resetModules();
    const dom = installDom({ url: "http://127.0.0.1:19280/view/alpha" });
    const app = dom.document.createElement("div"); app.id = "app"; dom.document.body.appendChild(app);
    dom.document.body.setAttribute("data-mode", "view-only");
    const g = globalThis as any;
    const sources: string[] = [], reads: string[] = [];
    g.EventSource = class { constructor(u: string) { sources.push(u); } addEventListener() {} close() {} };
    g.fetch = async (u: string, init: { method?: string } = {}) => {
      reads.push(`${init.method ?? "GET"} ${u}`);
      if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
      if (u.startsWith("/api/pane/")) return { ok: true, status: 200, headers: { get: () => "80" }, text: async () => "hello" };
      if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
      return { ok: false, status: 401, json: async () => ({}) };
    };
    // Nothing that needs a session may even be imported (in a browser that would be a request under /ui/js/).
    const imported: string[] = [];
    vi.doMock("/ui/js/panel-chat.js", async () => { imported.push("panel-chat"); throw new Error("not in View-only"); });
    vi.doMock("/ui/js/panel-fleet.js", async () => { imported.push("panel-fleet"); throw new Error("not in View-only"); });
    const { options } = await import("/assets/preact.module.js");
    options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    try {
      await import("/assets/app.js");
      await vi.waitFor(() => expect(app.querySelector(".v-card")).not.toBeNull());
      const sidebar = app.querySelector("#sidebar")!;
      const navLinks = sidebar.querySelectorAll("a").map((a: any) => a.getAttribute("href")).filter((h: string) => !h.startsWith("/view/"));
      expect(navLinks).toEqual(["/view", "/view", "/signin?next=%2Fview%2Falpha"]);   // brand, the View row, Sign in
      expect(sidebar.innerHTML).not.toMatch(/\/ui|\/settings|Session|New instance/);
      expect(app.querySelector(".tabs")!.querySelectorAll("a").map((a: any) => a.getAttribute("href"))).toEqual(["/view/alpha", "/signin?next=%2Fview%2Falpha"]);
      expect(app.querySelector(".v-card a.btn")!.getAttribute("href")).toBe("/signin?next=%2Fview%2Falpha");   // "Sign in to edit"
      await new Promise(r => setTimeout(r, 1000));
      expect(sources).toEqual([]);
      expect(imported).toEqual([]);
      const paths = [...new Set(reads.map(r => r.split(" ")[1]!.split("?")[0]!))];
      // #1523 N3: no /api/ai-usage probe — the page says whether usage is offered (data-usage-panel).
      expect(paths.sort()).toEqual(["/api/pane/alpha", "/api/profiles"]);
      for (const p of paths) expect(isPassiveWebRead("GET", p), p).toBe(true);
      expect(reads.every(r => r.startsWith("GET "))).toBe(true);
    } finally { dom.restore(); delete g.EventSource; delete g.fetch; vi.resetModules(); }
  }, 20_000);
});


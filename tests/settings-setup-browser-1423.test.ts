import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { SETUP_FORM_HTML } from "../src/setup-form.js";

/** Full shipped script, inert DOM/network; no browser, provider or fleet. */
function browser(ready = false) {
  const elements = new Map<string, any>();
  function element(tag = "input") {
    const item: any = { tag, children: [], disabled: false, hidden: false, value: "", textContent: "", className: "", listeners: new Map(),
      addEventListener(event: string, callback: any) { this.listeners.set(event, callback); },
      append(...children: any[]) { this.children.push(...children); for (const child of children) if (child.id) elements.set(child.id, child); } };
    Object.defineProperty(item, "innerHTML", { get: () => "", set() {
      const remove = (child: any) => { if (child.id) elements.delete(child.id); child.children.forEach(remove); };
      item.children.forEach(remove); item.children = [];
    } }); return item;
  }
  for (const match of SETUP_FORM_HTML.matchAll(/<(input|select|button|div|span|pre)[^>]*\bid="([^"]+)"/g)) {
    const item = element(match[1]); item.id = match[2]; elements.set(item.id, item);
  }
  const $ = (id: string) => elements.get(id);
  let lost = false, serial = 0, releaseDetect!: (value: any) => void;
  const detected = new Promise<any>(resolve => { releaseDetect = resolve; });
  const fetch = vi.fn(async (path: string, options?: any) => {
    let body: any = {};
    if (path === "api/settings/quickstart/environment") body = { backends: ["kiro-cli"] };
    if (path === "api/settings/pending") body = [];
    if (path === "setup/status") body = { finish_ready: ready };
    if (path === "api/settings/quickstart/probe") {
      const input = JSON.parse(options.body);
      body = input.action === "verify" ? { identity: { valid: true } } : await detected;
    }
    if (path === "api/settings/quickstart/commit") {
      if (lost) { lost = false; throw Error("lost response"); }
      body = { result: "pending_confirmation", pending_change: { id: "same" } };
    }
    if (path === "setup/finish") body = { watch: false };
    return { ok: true, status: 200, json: async () => body };
  });
  const context = createContext({ fetch, document: { getElementById: $, createElement: element,
    querySelectorAll: () => [...elements.values()].filter(item => ["input", "select", "button"].includes(item.tag) && item.id !== "finish") },
    crypto: { randomUUID: () => "key-" + ++serial }, setTimeout: vi.fn(), Date });
  const script = SETUP_FORM_HTML.slice(SETUP_FORM_HTML.indexOf("<script>") + 8, SETUP_FORM_HTML.indexOf("</script>"));
  expect(script).toContain("let approvedSetup"); runInContext(script, context);
  const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
  const edit = (id: string, value: string) => { const field = $(id); if (!field.disabled) { field.value = value; field.listeners.get("input")?.(); } };
  const click = (id: string) => $(id).disabled ? Promise.resolve() : Promise.resolve($(id).onclick());
  return { $, fetch, flush, edit, click, lose: () => { lost = true; }, releaseDetect };
}
it("same-cookie reload restores explicit Start from server finish readiness, with no automatic commit or finish", async () => {
  const h = browser(true); await h.flush();
  expect(h.$("finish").disabled).toBe(false); expect(h.$("finish").textContent).toBe("Start AgEnD");
  expect(h.fetch.mock.calls.some(([path]) => path === "setup/finish" || path === "api/settings/quickstart/commit")).toBe(false);
  await h.click("finish"); expect(h.fetch.mock.calls.filter(([path]) => path === "setup/finish")).toHaveLength(1);
});
it("lost-response retry freezes dynamic destination, admin, platform and delayed Detect results to the visible submitted bytes", async () => {
  const h = browser(); await h.flush();
  h.edit("token", "private-token"); h.edit("tokenEnv", "AGEND_BOT_TOKEN"); h.edit("dir", "/tmp/app"); h.edit("name", "worker");
  h.edit("group", "-100111"); h.edit("admin", "42"); await h.click("verify"); await h.click("preview");
  const detecting = h.click("detect"); h.lose(); await h.click("finish");
  for (const id of ["group", "admin", "token", "dir", "name", "backend", "detect", "verify", "preview", "pickTelegram", "pickDiscord"]) expect(h.$(id).disabled, id).toBe(true);
  h.edit("group", "-100222"); h.edit("admin", "99"); await h.click("pickDiscord");
  h.releaseDetect({ offset: 1, found: { groupId: "-100222", userId: "99" } }); await detecting;
  expect(h.$("group").value).toBe("-100111"); expect(h.$("admin").value).toBe("42");
  await h.click("finish"); const writes = h.fetch.mock.calls.filter(([path]) => path === "api/settings/quickstart/commit");
  expect(writes).toHaveLength(2); expect(writes[1][1]).toEqual(writes[0][1]);
  expect(JSON.parse(writes[1][1].body)).toMatchObject({ platform: "telegram", group_id: "-100111", admin_user_id: "42" });
});

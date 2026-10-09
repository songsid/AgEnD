/**
 * #1425 review: what happens after an await, and what the router leaves alone.
 * 1. Retry is a real new attempt: a panel module that failed to load loads again (the production Outlet), and the
 *    chat's loader can recover after a failure.
 * 2. A delete that finishes after the person moved to another chat never closes or navigates the page they are on;
 *    an unchanged dialog still goes back to /ui.
 * 3. A Fleet refresh keeps an open create dialog and its draft; a form that went away never closes its replacement.
 * 4. New instance: Create waits for the backend list; a failed list keeps the explicit "fleet default".
 * 5. The skip link is the browser's: not taken over, not a navigation.
 * 6. #1423: a create or a delete that needs a fleet admin's confirmation closes its dialog at once and is followed by
 *    the app (appStore.pendingChanges); a delete that is only pending never navigates.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let html: any, useState: any, shell: any, app: any, nav: any, chat: any, fleet: any;
type Handler = (path: string, init: { method?: string; body?: string }) => Promise<unknown> | unknown;
let handler: Handler = () => ({});
const requests: string[] = [];
const fetchFake = async (path: string, init: { method?: string; body?: string } = {}) => {
  requests.push(`${init.method ?? "GET"} ${path}${init.body ? ` ${init.body}` : ""}`);
  const body: any = await handler(path, init);
  // `__status` lets a handler answer like the confirmation gate does (202 pending_confirmation).
  const status = body && typeof body.__status === "number" ? body.__status : 200;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };
const stream = { on() { return () => {}; } };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  ({ html, useState } = await import("/assets/app-html.js"));
  shell = await import("/assets/app-shell.js");
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  chat = await import("/ui/js/panel-chat.js");
  fleet = await import("/ui/js/panel-fleet.js");
  chat.boot({ stream, boot: null, deps: { fetch: fetchFake } });
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  requests.length = 0;
  handler = (path) => path.startsWith("/ui/history") ? { messages: [] } : {};
  app.applyStatus({ uptime: 1, instances: [
    { name: "alpha", status: "running", state: "idle", execution_state: "idle" },
    { name: "beta", status: "running", state: "idle", execution_state: "idle" },
  ] });
});

describe("1. Retry is a real new attempt", () => {
  it("retryable(): a failed attempt is forgotten, the next call loads afresh with the next attempt number; calls in flight share one", async () => {
    const attempts: number[] = [];
    let fail = true;
    const load = shell.retryable(async (a: number) => { attempts.push(a); if (fail) throw new Error("offline"); return `module-${a}`; });
    const [x, y] = [load(), load()];
    await expect(x).rejects.toThrow("offline");
    await expect(y).rejects.toThrow("offline");
    fail = false;
    await expect(load()).resolves.toBe("module-1");
    await expect(load()).resolves.toBe("module-1");       // a success is kept
    expect(attempts).toEqual([0, 1]);
  });

  it("the production Outlet: a panel whose module failed shows Retry, and Retry loads it", async () => {
    let fail = true, calls = 0;
    const Fleet = () => html`<div class="loaded-panel">FLEET</div>`;
    const panels = new Map([["fleet", { load: shell.retryable(async () => { calls++; if (fail) throw new Error("x"); return Fleet; }) }]]);
    nav.navigate("/ui/fleet");
    await p.mount(h(shell.Shell, { panels, onNewInstance() {} }));
    await settle(6);
    expect(p.root.querySelector(".error-state")).not.toBeNull();
    expect(calls).toBe(1);
    fail = false;
    p.root.querySelector(".error-state button").click();
    await settle(6);
    expect(calls).toBe(2);
    expect(p.root.querySelector(".loaded-panel")?.textContent).toBe("FLEET");
    expect(p.root.querySelector(".error-state")).toBeNull();
  });

  it("the app's chat loader is retryable and asks a fresh URL on retry", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/ui/shared/app.js", import.meta.url), "utf8");
    expect(src).toMatch(/const loadChat = retryable\(\(a\) => import\(retryUrl\("\/ui\/js\/panel-chat\.js", a\)\)/);
    expect(src).toMatch(/panels\.set\("chat", \{ load: \(\) => \(chatLoads\+\+ === 0 \? chatBoot : loadChat\(\)\)\.then/);
    expect(src).toMatch(/attempt \? `\$\{path\}\?retry=\$\{attempt\}` : path/);
  });
});

describe("2. a delete that finishes late never takes over the page", () => {
  async function startDelete(name: string, held: ReturnType<typeof gate>) {
    handler = async (path) => {
      if (path.endsWith("/delete")) { await held.p; return { deleted: true }; }
      return path.startsWith("/ui/history") ? { messages: [] } : {};
    };
    nav.navigate(`/ui/chat/${name}`);
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: name }, navKey: `chat:${name}|1|en` }));
    p.root.querySelector(".panel-head .menu > button").click(); await settle();
    [...p.root.querySelectorAll(".menu-item")].find((b: any) => b.textContent.includes("Delete"))!.click(); await settle();
    const input = p.root.querySelector("dialog input");
    input.value = `delete ${name}`; fire(input, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Delete")!.click(); await settle();
  }

  it("A → B while the delete of A is on its way: B stays on screen and in the address bar", async () => {
    const held = gate();
    await startDelete("alpha", held);
    nav.navigate("/ui/chat/beta");
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: "beta" }, navKey: "chat:beta|2|en" }));
    const seq = nav.navStore.get().seq;
    held.open(); await settle(6);
    expect(p.window.location.pathname).toBe("/ui/chat/beta");
    expect(nav.navStore.get().seq).toBe(seq);
    expect(p.root.querySelector(".panel-title h1")?.textContent).toBe("beta");
  });

  it("Back to A after leaving it: the dialog that was left still does nothing", async () => {
    const held = gate();
    await startDelete("alpha", held);
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: "beta" }, navKey: "chat:beta|2|en" }));
    nav.navigate("/ui/chat/alpha");
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: "alpha" }, navKey: "chat:alpha|3|en" }));
    const seq = nav.navStore.get().seq;
    held.open(); await settle(6);
    expect(p.window.location.pathname).toBe("/ui/chat/alpha");
    expect(nav.navStore.get().seq).toBe(seq);
  });

  it("control: the dialog still open when the delete succeeds closes and goes back to /ui", async () => {
    const held = gate();
    await startDelete("alpha", held);
    held.open(); await settle(6);
    expect(p.window.location.pathname).toBe("/ui");
    expect(p.root.querySelector("dialog")).toBeNull();
  });
});

describe("3. a Fleet refresh keeps an open form", () => {
  const TASKS = { tasks: [{ id: "t1", title: "One", status: "open" }] };
  it("Claim resolves while New task is open with a draft: the same dialog, the same draft", async () => {
    const claim = gate();
    handler = async (path, init) => {
      if (path === "/ui/tasks/t1" && init.method === "POST") { await claim.p; return { ok: true }; }
      if (path === "/ui/tasks") return TASKS;
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".row-item .btn").click();                 // Claim (held)
    p.root.querySelector(".list-head .btn").click(); await settle(); // New task
    const dlg = p.root.querySelector("dialog");
    const title = dlg.querySelector("input");
    title.value = "my draft"; fire(title, "input"); await settle();
    claim.open(); await settle(8);
    expect(requests.filter(r => r === "GET /ui/tasks")).toHaveLength(2);   // the list was refreshed
    expect(p.root.querySelector("dialog")).toBe(dlg);
    expect(p.root.querySelector("dialog input").value).toBe("my draft");
  });

  it("a form that went away while creating never closes the form that replaced it", async () => {
    const create = gate();
    handler = async (path, init) => {
      if (path === "/ui/tasks" && init.method === "POST") { await create.p; return { id: "t9" }; }
      if (path === "/ui/tasks") return TASKS;
      if (path === "/ui/teams") return { teams: {} };
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".list-head .btn").click(); await settle();
    const t1 = p.root.querySelector("dialog input"); t1.value = "first"; fire(t1, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Create")!.click(); await settle();
    // The person moves on; on the new tab they open another form and start typing.
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "teams" }, navKey: "fleet:teams|2|en" }));
    await settle(4);
    p.root.querySelector(".list-head .btn").click(); await settle();
    const replacement = p.root.querySelector("dialog");
    const t2 = replacement.querySelector("input"); t2.value = "second"; fire(t2, "input"); await settle();
    const gets = requests.filter(r => r === "GET /ui/teams").length;
    create.open(); await settle(8);
    expect(p.root.querySelector("dialog")).toBe(replacement);
    expect(replacement.querySelector("input").value).toBe("second");
    expect(requests.filter(r => r === "GET /ui/teams")).toHaveLength(gets);   // and no refresh it did not ask for
  });
});

describe("3b. the list stays while it refreshes, and a form's late success is its own", () => {
  it("while the refreshed list is on its way, the old one stays on screen (no skeleton)", async () => {
    const second = gate();
    let gets = 0;
    handler = async (path, init) => {
      if (path === "/ui/tasks/t1" && init.method === "POST") return { ok: true };
      if (path === "/ui/tasks") { gets++; if (gets === 2) await second.p; return { tasks: [{ id: "t1", title: "One", status: "open" }] }; }
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".row-item .btn").click(); await settle(6);
    expect(gets).toBe(2);
    expect(p.root.querySelector(".skeleton")).toBeNull();
    expect(p.root.querySelector(".row-item")).not.toBeNull();
    second.open(); await settle(4);
  });

  it("a form replaced while its request is held: the late success closes nothing and refreshes nothing", async () => {
    const held = gate();
    handler = async (path, init) => { if (init.method === "POST") { await held.p; return { id: "x" }; } return {}; };
    const calls: string[] = [];
    let swap!: () => void;
    function Parent() {
      const [which, setWhich] = useState("a");
      swap = () => setWhich("b");
      const submit = { path: "/ui/tasks", done: "done", after: () => calls.push(`after-${which}`), collect: () => ({ title: which }) };
      return h(fleet.FormDialog, { key: which, title: which, onClose: () => calls.push(`close-${which}`), submit }, h("input", { class: `in-${which}` }));
    }
    await p.mount(h(Parent, {}));
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Create")!.click(); await settle();
    swap(); await settle(4);
    expect(p.root.querySelector(".in-b")).not.toBeNull();
    held.open(); await settle(6);
    expect(calls).toEqual([]);
    expect(p.root.querySelector(".in-b")).not.toBeNull();
  });
});

describe("4. New instance waits for the backend list", () => {
  const openDialog = async () => { await p.mount(h(fleet.CreateInstanceDialog, { onClose() {} })); await settle(); };
  const createBtn = () => [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Create") as any;
  const setTopic = async (v: string) => { const i = p.root.querySelectorAll("dialog input")[1]; i.value = v; fire(i, "input"); await settle(); };

  it("slow list: Create is off and sends nothing; once the list is in, the shown backend is the one sent", async () => {
    const list = gate();
    handler = async (path) => {
      if (path === "/ui/backends") { await list.p; return { backends: [{ name: "codex", installed: true }, { name: "claude-code", installed: false }] }; }
      return { ok: true };
    };
    await openDialog();
    await setTopic("demo");
    expect(createBtn().disabled).toBe(true);
    createBtn().click(); await settle();
    expect(requests.filter(r => r.startsWith("POST /ui/instances"))).toEqual([]);
    list.open(); await settle(6);
    expect(createBtn().disabled).toBe(false);
    expect(p.root.querySelector("dialog select").value).toBe("codex");
    createBtn().click(); await settle(4);
    const post = requests.find(r => r.startsWith("POST /ui/instances"))!;
    expect(JSON.parse(post.slice(post.indexOf("{")))).toMatchObject({ topic_name: "demo", backend: "codex" });
  });

  it("failed list: Create works with the explicit 'fleet default' (no backend sent)", async () => {
    handler = async (path) => { if (path === "/ui/backends") throw new Error("down"); return { ok: true }; };
    await openDialog();
    await settle(4);
    await setTopic("demo");
    expect(createBtn().disabled).toBe(false);
    expect(p.root.querySelector("dialog select").value).toBe("");
    createBtn().click(); await settle(4);
    const post = requests.find(r => r.startsWith("POST /ui/instances"))!;
    expect(JSON.parse(post.slice(post.indexOf("{")))).toEqual({ topic_name: "demo" });
  });
});

describe("5. the skip link is the browser's", () => {
  it("a click on it is not taken over and is not a navigation; its target can take focus", async () => {
    const panels = new Map([["chat", { load: async () => () => html`<div>chat</div>` }]]);
    nav.navigate("/ui/chat/alpha");
    await p.mount(h(shell.Shell, { panels, onNewInstance() {} }));
    const seq = nav.navStore.get().seq, path = p.window.location.pathname;
    const skip = p.root.querySelector("a.skip");
    expect(skip.getAttribute("href")).toBe("#main");
    const e = fire(skip, "click", { button: 0 });
    expect(e.defaultPrevented).toBe(false);
    expect(nav.navStore.get().seq).toBe(seq);
    expect(p.window.location.pathname).toBe(path);
    expect(p.root.querySelector("#main").getAttribute("tabindex")).toBe("-1");
    // Control: a real route link is still taken over.
    const link = p.root.querySelector('a.side-row[href="/ui/fleet"]');
    const e2 = fire(link, "click", { button: 0 });
    expect(e2.defaultPrevented).toBe(true);
    expect(nav.navStore.get().seq).toBe(seq + 1);
  });
});

describe("6. #1423: a write waiting for a fleet admin's confirmation", () => {
  const ID = "e".repeat(32);
  const view = (state: string) => ({ id: ID, state, section: "access", requested_at: 1, requested_by: "Chrome", expires_at: 2, remaining_ms: 280_000,
    source: "web_session", summary: ["instance: create demo"], confirmation: { kind: "chat" }, can_withdraw: state === "pending", outcome: state === "applied" ? { state, result: { ok: true } } : null });
  const pending = { __status: 202, ok: true, result: "pending_confirmation", pending_change: view("pending") };
  let confirmMod: any;
  beforeAll(async () => { confirmMod = await import("/ui/js/settings-confirm.js"); });
  afterEach(() => confirmMod.resetConfirmations());

  it("New instance: the dialog goes at once, the request is followed, and nothing says 'created' while it waits", async () => {
    let decided = "pending";
    handler = async (path) => {
      if (path === "/ui/backends") return { backends: [{ name: "codex", installed: true }] };
      if (path === "/ui/instances") return pending;
      if (path === `/api/settings/pending/${ID}`) return view(decided);
      return {};
    };
    let closed = 0;
    await p.mount(h(fleet.CreateInstanceDialog, { onClose() { closed++; } })); await settle(4);
    const topic = p.root.querySelectorAll("dialog input")[1]; topic.value = "demo"; fire(topic, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Create")!.click(); await settle(4);
    expect(closed).toBe(1);
    expect(app.appStore.get().pendingChanges.map((x: any) => [x.id, x.state, x.label])).toEqual([[ID, "pending", "New instance"]]);
    decided = "applied";
    await vi.waitFor(() => expect(app.appStore.get().pendingChanges[0]?.state).toBe("applied"), { timeout: 5000 });
    expect(closed).toBe(1);                                    // a dialog that went is never closed again
  }, 10_000);

  it("Delete: only pending — the dialog goes, the page stays where it is", async () => {
    handler = async (path) => {
      if (path.endsWith("/delete")) return pending;
      if (path === `/api/settings/pending/${ID}`) return view("pending");
      return path.startsWith("/ui/history") ? { messages: [] } : {};
    };
    nav.navigate("/ui/chat/alpha");
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: "alpha" }, navKey: "chat:alpha|9|en" }));
    p.root.querySelector(".panel-head .menu > button").click(); await settle();
    [...p.root.querySelectorAll(".menu-item")].find((b: any) => b.textContent.includes("Delete"))!.click(); await settle();
    const input = p.root.querySelector("dialog input");
    input.value = "delete alpha"; fire(input, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Delete")!.click(); await settle(4);
    expect(p.root.querySelector("dialog")).toBeNull();
    expect(p.window.location.pathname).toBe("/ui/chat/alpha");
    expect(app.appStore.get().pendingChanges.map((x: any) => x.state)).toEqual(["pending"]);
  });

  it("Fleet config: an older save decided late never unlocks the form under a newer save still on its way (#1453 review)", async () => {
    let decided = "pending", posts = 0;
    const second = gate();
    handler = async (path, init) => {
      if (path === "/ui/config" && init.method !== "POST") return { channel: { type: "discord", group_id: "1", access: { mode: "locked", allowed_users: ["2"] } }, defaults: { backend: "codex" }, project_roots: [] };
      if (path === "/ui/config") { posts++; if (posts === 1) return pending; await second.p; return { ok: true }; }
      if (path === `/api/settings/pending/${ID}`) return view(decided);
      return {};
    };
    nav.navigate("/ui/fleet/config");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "config" }, navKey: "fleet:config|1|en" }));
    await settle(6);
    const save = () => [...p.root.querySelectorAll(".save-row .btn")].find((b: any) => b.textContent.includes("Save"))!;
    save().click(); await settle(4);                               // A: pending — the form is free again
    expect(save().disabled).toBe(false);
    save().click(); await settle(4);                               // B: on its way
    expect(save().disabled).toBe(true);
    decided = "applied";                                           // A is decided now
    await vi.waitFor(() => expect(app.appStore.get().pendingChanges[0]?.state).toBe("applied"), { timeout: 5000 });
    await settle(4);
    expect(save().disabled).toBe(true);                            // still B's
    second.open(); await settle(6);
    expect(save().disabled).toBe(false);
  }, 10_000);

  it("Delete, then confirmed while the page is still on that chat: the dialog that handed over does not navigate", async () => {
    let decided = "pending";
    handler = async (path) => {
      if (path.endsWith("/delete")) return pending;
      if (path === `/api/settings/pending/${ID}`) return view(decided);
      return path.startsWith("/ui/history") ? { messages: [] } : {};
    };
    nav.navigate("/ui/chat/alpha");
    await p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance: "alpha" }, navKey: "chat:alpha|10|en" }));
    p.root.querySelector(".panel-head .menu > button").click(); await settle();
    [...p.root.querySelectorAll(".menu-item")].find((b: any) => b.textContent.includes("Delete"))!.click(); await settle();
    const input = p.root.querySelector("dialog input");
    input.value = "delete alpha"; fire(input, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Delete")!.click(); await settle(4);
    const seq = nav.navStore.get().seq;
    decided = "applied";
    await vi.waitFor(() => expect(app.appStore.get().pendingChanges[0]?.state).toBe("applied"), { timeout: 5000 });
    await settle(4);
    expect(nav.navStore.get().seq).toBe(seq);
    expect(p.window.location.pathname).toBe("/ui/chat/alpha");
  }, 10_000);
});

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
  (globalThis as any).localStorage.removeItem("agend_tasks_project");     // the board opens on Home, not the last project
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

// The Tasks tab is the task board (fleet-tasks.js): a project's tile on Home, the cards waiting for the person.
const PROJECT = { id: 1, name: "Game", description: "", archived: false, sort: 1, createdAt: "2026-10-20T00:00:00.000Z" };
const REVIEW_CARD = { id: "M-1", uuid: "u1", kind: "main", projectId: 1, parentId: null, title: "One", status: "review", assignee: "alpha",
  priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "", acceptance: [], context: "", state: "", blockedReason: "",
  result: "GET /leaderboard answers in 40 ms", sort: 1, createdBy: "Ann", version: 3, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
  startedAt: null, submittedAt: null, doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 },
  unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null };
const BOARD = { projects: [PROJECT], cards: [REVIEW_CARD] };

describe("alpha.2 sweep: a Fleet read the server refuses is an error, not an empty list", () => {
  it("/ui/tasks/board answering 500 { error } shows the error state with Try again — not an empty board", async () => {
    handler = (path) => (path === "/ui/tasks/board" ? { __status: 500, error: "boom" } : {});
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|err|en" }));
    await settle(6);
    expect(!!p.root.querySelector(".error-state"), "the error state").toBe(true);
    expect(!!p.root.querySelector(".empty"), "not the empty state").toBe(false);
    expect(!!p.root.querySelector(".error-state button"), "with Try again").toBe(true);
    handler = (path) => (path === "/ui/tasks/board" ? { cards: [], projects: [] } : {});
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|ok|en" }));
    await settle(6);
    expect(!!p.root.querySelector(".empty"), "an empty board is the empty state").toBe(true);
  });
  it("one of a thing is singular: '1 main task', not '1 main tasks'", async () => {
    handler = (path) => (path === "/ui/tasks/board" ? BOARD : {});
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|one|en" }));
    await settle(6);
    expect(p.root.querySelector(".tb-project-meta span").textContent).toBe("1 main task");
  });
});

describe("3. a Fleet refresh keeps an open form", () => {
  it("Confirm resolves while New project is open with a draft: the same dialog, the same draft", async () => {
    const confirm = gate();
    handler = async (path, init) => {
      if (path === "/ui/tasks/cards/M-1/move" && init.method === "POST") { await confirm.p; return { card: { ...REVIEW_CARD, status: "done" }, notes: [] }; }
      if (path === "/ui/tasks/board") return BOARD;
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".tb-wait-row .btn-primary").click();         // Confirm (held)
    p.root.querySelector(".list-head .btn-primary").click(); await settle();    // New project
    const dlg = p.root.querySelector("dialog");
    const name = dlg.querySelector("input");
    name.value = "my draft"; fire(name, "input"); await settle();
    confirm.open(); await settle(8);
    expect(requests.filter(r => r.startsWith("POST /ui/tasks/cards/M-1/move"))).toHaveLength(1);
    expect(requests.filter(r => r === "GET /ui/tasks/board")).toHaveLength(2);   // the board was read again
    expect(p.root.querySelector("dialog")).toBe(dlg);
    expect(p.root.querySelector("dialog input").value).toBe("my draft");
  });

  it("a form that went away while creating never closes the form that replaced it", async () => {
    const create = gate();
    handler = async (path, init) => {
      if (path === "/ui/tasks/projects" && init.method === "POST") { await create.p; return { project: { ...PROJECT, id: 2, name: "first" } }; }
      if (path === "/ui/tasks/board") return BOARD;
      if (path === "/ui/teams") return { teams: {} };
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".list-head .btn-primary").click(); await settle();
    const t1 = p.root.querySelector("dialog input"); t1.value = "first"; fire(t1, "input"); await settle();
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Create")!.click(); await settle();
    // The person moves on; on the new tab they open another form and start typing.
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "teams" }, navKey: "fleet:teams|2|en" }));
    await settle(4);
    p.root.querySelector(".list-head .btn-primary").click(); await settle();
    const replacement = p.root.querySelector("dialog");
    const t2 = replacement.querySelector("input"); t2.value = "second"; fire(t2, "input"); await settle();
    const gets = requests.filter(r => r === "GET /ui/teams").length;
    const boards = requests.filter(r => r === "GET /ui/tasks/board").length;
    create.open(); await settle(8);
    expect(p.root.querySelector("dialog")).toBe(replacement);
    expect(replacement.querySelector("input").value).toBe("second");
    expect(requests.filter(r => r === "GET /ui/teams")).toHaveLength(gets);              // and no refresh it did not ask for
    expect(requests.filter(r => r === "GET /ui/tasks/board")).toHaveLength(boards);
  });
});

describe("3a. one answer per card at a time", () => {
  it("Confirm clicked twice while its move is held sends one move; the button is off meanwhile", async () => {
    const move = gate();
    handler = async (path, init) => {
      if (path === "/ui/tasks/cards/M-1/move" && init.method === "POST") { await move.p; return { card: { ...REVIEW_CARD, status: "done" }, notes: [] }; }
      if (path === "/ui/tasks/board") return BOARD;
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|dbl|en" }));
    await settle(4);
    const confirm = p.root.querySelector(".tb-wait-row .btn-primary");
    confirm.click(); confirm.click(); await settle();
    expect(p.root.querySelector(".tb-wait-row .btn-primary").disabled).toBe(true);
    move.open(); await settle(8);
    expect(requests.filter(r => r.startsWith("POST /ui/tasks/cards/M-1/move"))).toHaveLength(1);
  });
});

describe("3c. the public link shows the board and changes nothing (the server refuses it too)", () => {
  afterEach(() => { (globalThis as any).document.body.removeAttribute("data-public-link"); });

  it("a read-only note; no Confirm or Send back, no New project; on a project, no New main task and no dragging", async () => {
    (globalThis as any).document.body.dataset.publicLink = "1";
    const open = { ...REVIEW_CARD, id: "M-2", uuid: "u2", status: "open", needsReview: false };
    handler = (path) => (path === "/ui/tasks/board" ? { ...BOARD, cards: [REVIEW_CARD, open] } : {});
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|link|en" }));
    await settle(6);
    expect(p.root.querySelector(".tb-readonly")?.textContent).toContain("read-only");
    expect(p.root.querySelector(".tb-wait-row")).not.toBeNull();                 // the waiting card is listed…
    expect(p.root.querySelectorAll(".tb-wait-row .btn")).toHaveLength(0);         // …with nothing to answer it with
    expect(p.root.querySelector(".list-head .btn-primary")).toBeNull();                 // no New project (Instances is a read)
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    expect(p.root.querySelectorAll(".tb-tile")).toHaveLength(2);
    expect([...p.root.querySelectorAll(".tb-tile")].map((el: any) => el.getAttribute("draggable"))).toEqual(["false", "false"]);
    expect([...p.root.querySelectorAll(".btn")].some((b: any) => b.textContent.includes("New main task"))).toBe(false);
    fire(p.root.querySelector(".tb-tile-title"), "keydown", { key: "ArrowRight", altKey: true }); await settle(4);
    expect(requests.filter(r => r.startsWith("POST"))).toEqual([]);
  });
});

describe("3d. a tile from the keyboard: its title is the button; Alt+arrows move it", () => {
  const A = { ...REVIEW_CARD, id: "M-1", status: "open", needsReview: false, sort: 1 };
  const B = { ...REVIEW_CARD, id: "M-2", uuid: "u2", title: "Two", status: "open", needsReview: false, sort: 2 };
  beforeEach(() => {
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return { projects: [PROJECT], cards: [A, B] };
      if (init.method === "POST" && path.endsWith("/move")) return { card: { ...A, status: "claimed" }, notes: [] };
      if (init.method === "POST" && path.endsWith("/reorder")) return { card: A };
      return {};
    };
  });

  it("the tile is a group with a real button in it, not a div acting as one", async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|kb1|en" }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    const tile = p.root.querySelector(".tb-tile");
    expect(tile.getAttribute("role")).toBeNull();
    expect(tile.getAttribute("tabindex")).toBeNull();
    expect(tile.querySelector(".tb-tile-title").tagName.toLowerCase()).toBe("button");
  });

  it("Alt+→ moves the card to the next status with the version seen; Alt+↓ puts it after the next card; a plain arrow does nothing", async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|kb2|en" }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    const title = () => p.root.querySelector('[data-tile="M-1"] .tb-tile-title');
    fire(title(), "keydown", { key: "ArrowRight" }); await settle(4);
    expect(requests.filter(r => r.startsWith("POST"))).toEqual([]);
    fire(title(), "keydown", { key: "ArrowRight", altKey: true }); await settle(6);
    expect(requests.filter(r => r.startsWith("POST"))).toEqual(['POST /ui/tasks/cards/M-1/move {"to":"claimed","version":3}']);
    requests.length = 0;
    fire(title(), "keydown", { key: "ArrowDown", altKey: true }); await settle(6);
    expect(requests.filter(r => r.startsWith("POST"))).toEqual(['POST /ui/tasks/cards/M-1/reorder {"after":"M-2","before":null}']);
  });
});

describe("3e. a send-back that meets an agent's write keeps what the person typed", () => {
  it("409: the card is read again, the reason is offered again as typed, and sent with the new version", async () => {
    let moves = 0;
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return BOARD;
      if (path === "/ui/tasks/cards/M-1" && (init.method ?? "GET") === "GET") return { card: { ...REVIEW_CARD, version: 5 } };
      if (path === "/ui/tasks/cards/M-1/move") {
        moves++;
        return moves === 1 ? { __status: 409, error: "M-1 changed meanwhile", code: "conflict", key: "conflict", args: ["M-1"] } : { card: { ...REVIEW_CARD, status: "claimed" }, notes: [] };
      }
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|409|en" }));
    await settle(6);
    [...p.root.querySelectorAll(".tb-wait-row .btn")].find((b: any) => b.textContent === "Send back")!.click(); await settle(4);
    const reason = p.root.querySelector("dialog textarea");
    reason.value = "the login page 500s"; fire(reason, "input"); await settle();
    p.root.querySelector("dialog .btn-primary").click(); await settle(8);
    // Asked again, with the text in place.
    expect(p.root.querySelector("dialog textarea").value).toBe("the login page 500s");
    p.root.querySelector("dialog .btn-primary").click(); await settle(8);
    expect(requests.filter(r => r.startsWith("POST /ui/tasks/cards/M-1/move"))).toEqual([
      'POST /ui/tasks/cards/M-1/move {"to":"claimed","reason":"the login page 500s","version":3}',
      'POST /ui/tasks/cards/M-1/move {"to":"claimed","reason":"the login page 500s","version":5}',
    ]);
    expect(p.root.querySelector("dialog")).toBeNull();
  });
});

describe("3f. confirming work that is not wrapped up asks first", () => {
  const RAW = { ...REVIEW_CARD, result: "", acceptance: [{ text: "resets Monday", done: false }] };
  const posts = () => requests.filter(r => r.startsWith("POST"));
  beforeEach(() => {
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return { projects: [PROJECT], cards: [RAW] };
      if (init.method === "POST") return { card: { ...RAW, status: "done" }, notes: [] };
      return {};
    };
  });

  it("the waiting row says what is missing; Confirm asks, backing out sends nothing, Confirm anyway sends the note", async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|wrap|en" }));
    await settle(6);
    expect(p.root.querySelector(".tb-wait-reason.wrapup").textContent).toBe("Not wrapped up yet: 1 checklist item unchecked, no result");
    p.root.querySelector(".tb-wait-row .btn-primary").click(); await settle(4);
    expect(p.root.querySelector("dialog .dlg-title, dialog h2")?.textContent ?? p.root.querySelector("dialog").textContent).toContain("Confirm M-1?");
    [...p.root.querySelectorAll("dialog .btn")].find((b: any) => b.textContent === "Cancel")!.click(); await settle(6);
    expect(posts()).toEqual([]);
    p.root.querySelector(".tb-wait-row .btn-primary").click(); await settle(4);
    const note = p.root.querySelector("dialog textarea"); note.value = "fine for now"; fire(note, "input"); await settle();
    const anyway = p.root.querySelector("dialog .btn-primary");
    expect(anyway.textContent).toBe("Confirm anyway");
    anyway.click(); await settle(8);
    expect(posts()).toEqual(['POST /ui/tasks/cards/M-1/move {"to":"done","reason":"fine for now","version":3}']);
  });

  it("its tile says To fill in; a wrapped-up card is confirmed without a question", async () => {
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return { projects: [PROJECT], cards: [{ ...REVIEW_CARD }, { ...RAW, id: "M-2", uuid: "u2" }] };
      if (init.method === "POST") return { card: { ...REVIEW_CARD, status: "done" }, notes: [] };
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|wrap2|en" }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    expect(p.root.querySelector('[data-tile="M-1"] .tb-tag.wrapup')).toBeNull();
    expect(p.root.querySelector('[data-tile="M-2"] .tb-tag.wrapup').textContent).toBe("To fill in");
    p.root.querySelector(".tb-bar-head .btn-ghost").click(); await settle(6);
    p.root.querySelector(".tb-wait-row .btn-primary").click(); await settle(8);      // M-1 is first: wrapped up
    expect(p.root.querySelector("dialog")).toBeNull();
    expect(posts()).toEqual(['POST /ui/tasks/cards/M-1/move {"to":"done","version":3}']);
  });
});

describe("3g. a main task's tile says who works on it now, not only who owns it", () => {
  const SUB = { ...REVIEW_CARD, kind: "sub", parentId: "M-1", needsReview: false, progress: null, title: "Review the API" };
  const board = (mainStatus: string, subs: Array<Record<string, unknown>>) => ({ projects: [PROJECT], cards: [
    { ...REVIEW_CARD, status: mainStatus, progress: { total: subs.length, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 } },
    ...subs.map((x, i) => ({ ...SUB, id: `S-${i + 1}`, uuid: `s${i + 1}`, sort: i + 1, ...x })),
  ] });
  async function tile(b: unknown, key: string) {
    handler = (path) => (path === "/ui/tasks/board" ? b : {});
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|${key}|en` }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    return p.root.querySelector('[data-tile="M-1"]');
  }

  it("the sub task in progress and its worker; else a blocked one; else the next one that can start", async () => {
    let t = await tile(board("claimed", [{ status: "claimed", assignee: "beta" }, { status: "open", assignee: "alpha" }]), "now1");
    expect(t.querySelector(".tb-tile-now").textContent).toBe("Working onS-1Review the API");
    expect(t.querySelector(".tb-tile-foot .tb-who").textContent).toBe("beta");
    expect(t.querySelector(".tb-tile-foot .tb-person").getAttribute("title")).toBe("Main task owner: alpha");
    t = await tile(board("blocked", [{ status: "blocked", assignee: "beta" }]), "now2");
    expect(t.querySelector(".tb-now-label").textContent).toBe("Blocked");
    t = await tile(board("open", [{ status: "open", assignee: null, unmetDeps: [] }, { status: "open", assignee: "beta", unmetDeps: ["S-1"] }]), "now3");
    expect(t.querySelector(".tb-tile-now").textContent).toBe("NextS-1Review the API");
    expect(t.querySelector(".tb-tile-foot .tb-who").textContent).toBe("Unassigned");
    t = await tile(board("review", [{ status: "done", assignee: "beta" }]), "now4");
    expect(t.querySelector(".tb-tile-now")).toBeNull();
    expect(t.querySelector(".tb-tile-foot .tb-who").textContent).toBe("Waiting for you");
  });
});

describe("3h. taskhall's looks: the card opens as a drawer; a tile's people have a round initial", () => {
  it("the initial takes an instance's identity colour; a person, or nobody, has none", async () => {
    const person = { ...REVIEW_CARD, id: "M-2", uuid: "u2", status: "open", assignee: "Ann" };
    const nobody = { ...REVIEW_CARD, id: "M-3", uuid: "u3", status: "open", assignee: null };
    handler = (path) => (path === "/ui/tasks/board" ? { ...BOARD, cards: [REVIEW_CARD, person, nobody] } : {});
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|who|en" }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    const foot = (id: string) => p.root.querySelector(`[data-tile="${id}"] .tb-tile-foot`);
    expect(foot("M-1").querySelector(".tb-av").textContent).toBe("A");
    expect(foot("M-1").querySelector(".tb-who").textContent).toBe("alpha");
    expect(foot("M-1").querySelector(".tb-av").style["--id-light"]).toMatch(/^#[0-9a-f]{6}$/);   // alpha is an instance
    expect(foot("M-2").querySelector(".tb-av").textContent).toBe("A");
    expect(foot("M-2").querySelector(".tb-av").style["--id-light"]).toBeFalsy();                    // Ann is a person
    expect(foot("M-3").querySelector(".tb-av")).toBeNull();
    expect(foot("M-3").querySelector(".tb-person.none .tb-who").textContent).toBe("Unassigned");
  });

  it("a tile's title opens the card in a drawer (a phone keeps the sheet: the stylesheet's), its assignee with the initial", async () => {
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return BOARD;
      if (path === "/ui/tasks/cards/M-1" && (init.method ?? "GET") === "GET") return { card: REVIEW_CARD, parent: null, children: [], comments: [], logs: [], history: [] };
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|drawer|en" }));
    await settle(6);
    p.root.querySelector(".tb-project-open").click(); await settle(6);
    p.root.querySelector('[data-tile="M-1"] .tb-tile-title').click(); await settle(8);
    const d = p.root.querySelector("dialog");
    expect(d.className).toBe("dlg dlg-wide dlg-drawer");
    expect(d.querySelector(".tc-meta .tb-person .tb-av").textContent).toBe("A");
    d.querySelector(".dlg-x").click(); await settle(4);                     // closed: ?card= leaves the address
    expect(p.root.querySelector("dialog")).toBeNull();
  });
});

describe("3i. who works on what: the board's Instance drawer (taskhall's)", () => {
  it("each instance with its cards in taskhall's order, working ones first, by group; a line opens the card, and the drawer gives way", async () => {
    const view = (id: string, extra: Record<string, unknown> = {}) => ({ ...REVIEW_CARD, id, uuid: id, title: `Card ${id}`, ...extra });
    const none = { doing: [], blocked: [], review: [], ready: [], waiting: [], mains: [], sentBack: [], newComments: [] };
    handler = (path, init) => {
      if (path === "/ui/tasks/board") return BOARD;
      if (path === "/ui/tasks/work") return { instances: [
        { ...none, name: "alpha", review: [view("M-1")], mains: [view("M-7", { progress: { total: 3, open: 1, claimed: 1, blocked: 0, review: 0, done: 1 } })],
          ready: [view("S-4", { kind: "sub", assignee: null })], waiting: [view("S-5", { kind: "sub", unmetDeps: ["S-4"] })], newComments: ["M-1"] },
        { ...none, name: "beta", doing: [view("S-2", { kind: "sub", status: "claimed", assignee: "beta" })], sentBack: ["S-2"] },
        { ...none, name: "Ann", ready: [view("M-9", { assignee: "Ann" })] },
      ] };
      if (path === "/ui/tasks/cards/S-2" && (init.method ?? "GET") === "GET") return { card: view("S-2", { kind: "sub", status: "claimed", assignee: "beta" }), parent: null, children: [], comments: [], logs: [], history: [] };
      return {};
    };
    app.appStore.set((st: any) => ({ ...st, exec: { ...st.exec, beta: "working" } }));
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|work|en" }));
    await settle(6);
    [...p.root.querySelectorAll(".tb-head .btn")].find((b: any) => b.textContent.includes("Instances"))!.click(); await settle(8);
    const d = p.root.querySelector("dialog");
    expect(d.className).toBe("dlg dlg-wide dlg-drawer");
    expect(d.querySelector(".tw-head").textContent).toBe("3 instance(s) · 1 working");
    expect([...d.querySelectorAll(".tw-group-head")].map((g: any) => g.textContent)).toEqual(["Other2", "Not in the fleet1"]);
    const lines = (inst: any) => [...inst.querySelectorAll(".tw-line")].map((l: any) => [l.querySelector(".tw-kind").textContent, l.querySelector(".tb-code").textContent,
      l.querySelector(".tw-note")?.textContent ?? "", !!l.querySelector(".tw-unread")]);
    const insts = [...d.querySelectorAll(".tw-inst")];
    expect(insts.map((i: any) => i.querySelector(".tw-name, .tb-who").textContent)).toEqual(["beta", "alpha", "Ann"]);   // working first
    expect(lines(insts[0])).toEqual([["Sent back", "S-2", "", false]]);
    expect(lines(insts[1])).toEqual([
      ["Waiting for you", "M-1", "", true], ["Owns", "M-7", "sub tasks 1/3", false],
      ["Can start", "S-4", "nobody's: can be taken", false], ["Waiting on", "S-5", "waits for S-4", false],
    ]);
    insts[0].querySelector(".tw-line").click(); await settle(8);
    const open = [...p.root.querySelectorAll("dialog")];
    expect(open.map((x: any) => x.getAttribute("aria-label"))).toEqual(["S-2 Card S-2"]);                  // the drawer gave way to the card
    open[0].querySelector(".dlg-x").click(); await settle(4);
    app.appStore.set((st: any) => ({ ...st, exec: {} }));
  });
});

describe("3b. the list stays while it refreshes, and a form's late success is its own", () => {
  it("while the refreshed board is on its way, the old one stays on screen (no skeleton)", async () => {
    const second = gate();
    let gets = 0;
    handler = async (path, init) => {
      if (path === "/ui/tasks/cards/M-1/move" && init.method === "POST") return { card: { ...REVIEW_CARD, status: "done" }, notes: [] };
      if (path === "/ui/tasks/board") { gets++; if (gets === 2) await second.p; return BOARD; }
      return {};
    };
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
    await settle(4);
    p.root.querySelector(".tb-wait-row .btn-primary").click(); await settle(6);
    expect(gets).toBe(2);
    expect(p.root.querySelector(".skeleton")).toBeNull();
    expect(p.root.querySelector(".tb-project")).not.toBeNull();
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
    // (#1523 N2: with an instance open, Fleet goes to its Details — still a route link.)
    const link = p.root.querySelector('a.side-row[href^="/ui/fleet"]');
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

  // (#2347 §10: Fleet → Config and its save are gone — its settings are saved by Settings' bar, covered there.)
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

describe("#1465 review: a delete confirmed after its tab went sends nothing", () => {
  it("schedules and teams", async () => {
    const C = await import("/assets/ui-confirm.js");
    (globalThis as any).confirm = undefined;
    try {
      for (const [tab, list, key] of [["schedules", { schedules: [{ id: "s1", label: "nightly", cron: "0 2 * * *", target: "alpha", enabled: true }] }, "/ui/schedules/"],
        ["teams", { teams: { core: { members: ["alpha"] } } }, "/ui/teams/"]] as const) {
        handler = async (path: string) => (path === `/ui/${tab}` ? list : {});
        nav.navigate(`/ui/fleet/${tab}`);
        await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab }, navKey: `fleet:${tab}|1|en` }));
        await settle(6);
        [...p.root.querySelectorAll(".row-item .btn")].find((b: any) => b.textContent.includes("Delete"))!.click();
        await settle(2);
        const q = C.confirmStore.get().queue[0];
        expect(q, tab).toBeDefined();
        await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|2|en" }));   // another tab: a new lease
        await settle(4);
        requests.length = 0;
        C.answerConfirm(q.id, true); await settle(6);
        expect(requests.filter((r: string) => r.startsWith(`DELETE ${key}`)), tab).toEqual([]);
      }
    } finally { (globalThis as any).confirm = () => true; }
  });
});

describe("#2072 (#2098 review P3-3): the model list with \"fleet default\" is the fleet default backend's", () => {
  it("no backend chosen: the models asked for are the fleet default backend's, not an empty list", async () => {
    const C = await import("/ui/js/settings-catalog.js"); C.forgetCatalogs();
    handler = async (path) => {
      if (path === "/ui/backends") return { backends: [{ name: "codex", installed: false }], defaultBackend: "codex" };
      if (path.startsWith("/ui/models")) return { models: [{ id: "gpt-5.5", label: "gpt-5.5" }] };
      return { ok: true };
    };
    requests.length = 0;
    await p.mount(h(fleet.CreateInstanceDialog, { onClose() {} })); await settle(8);
    expect(p.root.querySelector("dialog select").value).toBe("");                 // "fleet default"
    expect(requests).toContain("GET /ui/models?backend=codex");
    const options = [...p.root.querySelectorAll("dialog .model-pick option")].map((o: any) => o.value);
    expect(options).toContain("gpt-5.5");
  });
});

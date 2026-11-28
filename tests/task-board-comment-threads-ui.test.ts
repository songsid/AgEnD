/**
 * Comment threads on a card's page (docs/design/task-board.md, "Comment threads") as the page draws and sends them:
 *
 *   1. What is computed (pure): threads from a flat list, a reaction's chip, the recipient chip's groups and its default, a
 *      comment's address, and the ⋯ menu's items for each kind of viewer.
 *   2. The ⋯ menu and what each item sends: edit (the author's), react, reply, resolve and reopen, copy, copy link, delete.
 *   3. The recipient chip: the card's assignee at first, a reply's author on a reply, "No agent notified" for a person or a
 *      finished card; a choice is what is sent (`to`).
 *   4. A link to a comment scrolls to it and lights it, opening a resolved thread first.
 *   5. A read-only page offers none of it; what a comment says is never markup.
 *
 * The page is the real Tasks tab in tests/helpers/mini-dom.ts (as tests/task-board-page.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let p: AppPage;
let app: any, nav: any, fleet: any, thread: any, activity: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: "M-1", kind: "main", projectId: 1, parentId: null, title: "Serve the leaderboard", status: "claimed",
  assignee: "alpha", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };
const ANN = { name: "Ann", kind: "person" };
const at = (n: number) => `2026-11-02T1${n}:00:00.000Z`;
const c = (id: number, author: string, authorKind: string, text: string, extra: Record<string, unknown> = {}) => ({ id, author, authorKind, kind: "comment", text, at: at(id % 10), ...extra });
/** A thread: Ann's question (11), alpha's answer under it (12), Ann's follow-up under the answer (13), and a comment of its own (14). */
const COMMENTS = [
  c(11, "Ann", "person", "Is the **ranking** weekly?"),
  c(12, "alpha", "instance", "Yes, it resets on Monday.", { parentId: 11 }),
  c(13, "Ann", "person", "Thanks!", { parentId: 12, editedAt: at(5) }),
  c(14, "alpha", "instance", "Pushed the endpoint.", { reactions: [{ emoji: "👍", by: [{ name: "Ann", kind: "person" }, { name: "beta", kind: "instance" }] }] }),
];
let detail: Record<string, unknown>;
const detailOf = (over: Record<string, unknown> = {}) => ({ card: card({}), parent: null, children: [], comments: COMMENTS, logs: [], history: [], viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...over });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  thread = await import("/ui/js/fleet-task-thread.js");
  activity = await import("/ui/js/fleet-task-activity.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const posts = () => calls.filter((x) => x.method === "POST");
const written: string[] = [];
beforeEach(async () => {
  await p.unmount();
  for (const k of ["publicLink", "linkMedia", "tier"]) delete doc().body.dataset[k];
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0; written.length = 0;
  detail = detailOf();
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: [card({})], boardOff: ["quiet"] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)/.exec(path);
    if (m && method === "POST") return { card: card({}), comment: {}, notes: [] };
    if (m) return detail;
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "quiet"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
  (globalThis as any).navigator.clipboard = { writeText: async (s: string) => { written.push(s); } };
  (globalThis as any).isSecureContext = true;
});
afterEach(() => { (globalThis as any).confirm = undefined; });

let mounts = 0;
async function open(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|th-${++mounts}|en` }));
  await settle(8);
  fire(q(`[data-tile="M-1"] .tb-tile-title`), "click"); await settle(10);
}
const typeInto = async (el: any, value: string) => { el.value = value; el.selectionStart = value.length; fire(el, "input"); await settle(4); };
const comment = (id: number) => q(`#c${id}`);
/** Opens the ⋯ of a comment; the labels of its items. */
async function menuOf(id: number): Promise<string[]> {
  fire(comment(id).querySelector(".tl-menu > button"), "click"); await settle(4);
  return qa(".tl-menu .menu-list button").map((b) => text(b)!);
}
async function choose(id: number, label: string) {
  const items = await menuOf(id);
  expect(items, `${label} in the menu of c${id}`).toContain(label);
  fire(qa(".tl-menu .menu-list button").find((b) => text(b) === label), "click"); await settle(10);
}

describe("1. what is computed", () => {
  const entries = () => activity.timelineOf({ comments: COMMENTS, logs: [], history: [] });

  it("threadize: a reply goes under its thread's first comment, however deep, in time order; the rest stays where it was", () => {
    const flat = entries();
    const out = thread.threadize(flat, flat);
    expect(out.map((e: any) => e.id)).toEqual([11, 14]);
    expect(out[0].replies.map((e: any) => e.id)).toEqual([12, 13]);
    expect(out[1].replies).toBeUndefined();
  });

  it("threadize: a reply whose parent is not there (outside the window, left out of sight) or not shown stands alone", () => {
    const lonely = activity.timelineOf({ comments: [c(30, "alpha", "instance", "orphan", { parentId: 99 })], logs: [], history: [] });
    expect(thread.threadize(lonely, lonely).map((e: any) => e.id)).toEqual([30]);
    const flat = entries();
    // the comments filter shows all of them; a filter that hides the root (it cannot, but a list could) keeps the reply visible
    const noRoot = flat.filter((e: any) => e.id !== 11);
    expect(thread.threadize(noRoot, flat).map((e: any) => e.id)).toEqual([12, 13, 14]);
  });

  it("rootOf stops at a missing parent and cannot loop", () => {
    const byId = new Map([[1, { id: 1, parentId: 2 }], [2, { id: 2, parentId: 1 }]] as any);
    expect([1, 2]).toContain(thread.rootOf(byId.get(1), byId).id);
    expect(thread.rootOf({ id: 5, parentId: 77 }, new Map()).id).toBe(5);
  });

  it("a reaction's chip: the number, whether it is the viewer's, and who (the viewer first, three names, then 'N more')", () => {
    const r = { emoji: "👍", by: [{ name: "Ann", kind: "person" }, { name: "beta", kind: "instance" }, { name: "gamma", kind: "instance" }, { name: "delta", kind: "instance" }, { name: "eps", kind: "instance" }] };
    const v = thread.reactionView(r, ANN);
    expect(v).toMatchObject({ emoji: "👍", count: 5, mine: true });
    expect(v.label).toBe("You, beta, gamma and 2 more reacted with 👍");
    expect(thread.reactionView(r, null).mine).toBe(false);
    expect(thread.reactionView({ emoji: "🎉", by: [{ name: "beta", kind: "instance" }] }, ANN)).toMatchObject({ count: 1, mine: false, label: "beta reacted with 🎉" });
    // a person and an instance of the same name are two different reactors
    expect(thread.reactionView({ emoji: "👍", by: [{ name: "Ann", kind: "instance" }] }, ANN).mine).toBe(false);
  });

  it("a reaction's chip is the viewer's when the host says so (by key): another account with the viewer's name is not 'You'", () => {
    const by = [{ name: "Ann", kind: "person" }, { name: "Ann", kind: "person" }];
    expect(thread.reactionView({ emoji: "👍", by, mine: false }, ANN)).toMatchObject({ count: 2, mine: false, label: "Ann, Ann reacted with 👍" });
    expect(thread.reactionView({ emoji: "👍", by, mine: true }, ANN)).toMatchObject({ count: 2, mine: true, label: "You, Ann reacted with 👍" });
    expect(thread.reactionView({ emoji: "👍", by: [{ name: "Ann", kind: "person" }] }, ANN).mine, "a host that says nothing: by name and kind, as before").toBe(true);
  });

  it("a comment's address is the card's with its anchor; an address names a comment only in that form", () => {
    expect(thread.commentUrl("http://127.0.0.1:19280/ui/fleet?tp=1#c3", "M-12", 42)).toBe("http://127.0.0.1:19280/ui/fleet?tp=1&card=M-12#c42");
    expect(thread.commentInHash("#c42")).toBe(42);
    for (const bad of ["", "#42", "#c", "#c4x", "#cc4", "#c-4", "#c1234567890123", null, undefined]) expect(thread.commentInHash(bad), String(bad)).toBeNull();
  });

  const fleet3 = [{ name: "alpha", off: false }, { name: "beta", off: false }, { name: "lead", off: false }, { name: "quiet", off: true }, { name: "spare", off: false }];
  it("the chip's groups: assignee, who handed it out, watchers, the leader, the rest — each name once; a name that is no instance is not listed", () => {
    const groups = thread.recipientGroups({
      card: card({ assignee: "alpha", dispatcher: { kind: "instance", name: "lead" } }),
      detail: { watchers: ["beta", "ghost"], inheritedWatchers: ["alpha"], leader: { name: "lead", via: "project" } }, fleet: fleet3 });
    expect(groups.map((g: any) => [g.key, g.names.map((n: any) => n.name)])).toEqual([
      ["assignee", ["alpha"]], ["dispatcher", ["lead"]], ["watchers", ["beta"]], ["others", ["quiet", "spare"]]]);
    const board = thread.recipientGroups({ card: card({ assignee: null, dispatcher: null }), detail: { watchers: [], inheritedWatchers: [], leader: { name: "spare", via: "board" } }, fleet: fleet3 });
    expect(board.find((g: any) => g.key === "lead")).toMatchObject({ title: "taskthread.groupLeadBoard", names: [{ name: "spare" }] });
  });

  it("who the box starts with: the assignee when it is an instance the board can wake and the card is live; a reply's author when it is one; else nobody", () => {
    const d = (over: Record<string, unknown>, reply: unknown = null) => thread.defaultRecipient({ card: card(over), reply, fleet: fleet3 });
    expect(d({ assignee: "alpha" })).toBe("alpha");
    expect(d({ assignee: "Ann" }), "a person has no agent to start").toBeNull();
    expect(d({ assignee: null })).toBeNull();
    expect(d({ assignee: "ghost" }), "not in the fleet").toBeNull();
    expect(d({ assignee: "quiet" }), "its task board is off").toBeNull();
    expect(d({ assignee: "alpha", status: "done" }), "a finished card").toBeNull();
    expect(d({ assignee: "alpha", status: "cancelled" })).toBeNull();
    expect(d({ assignee: "alpha" }, { by: "instance", who: "beta" }), "a reply goes to the one it answers").toBe("beta");
    expect(d({ assignee: "alpha" }, { by: "person", who: "Ann" }), "a person's comment: the card's default").toBe("alpha");
    expect(d({ assignee: "alpha" }, { by: "instance", who: "quiet" }), "the one it answers cannot be woken: the card's default").toBe("alpha");
    expect(d({ assignee: "alpha", status: "done" }, { by: "instance", who: "beta" })).toBe("beta");
  });

  it("holdsRecipient: only a new comment on an open card that waits on another card, whose assignee is the chip's name", () => {
    const hold = (over: Record<string, unknown>, reply: unknown = null) => { const c = card(over); const initial = thread.defaultRecipient({ card: c, reply, fleet: fleet3 }); return thread.holdsRecipient({ card: c, reply, initial }); };
    expect(hold({ status: "open", unmetDeps: ["M-0"] })).toBe(true);
    expect(hold({ status: "open", unmetDeps: [], hiddenUnmet: 2 })).toBe(true);
    expect(hold({ status: "open", unmetDeps: [] })).toBe(false);
    expect(hold({ status: "claimed", unmetDeps: ["M-0"] })).toBe(false);
    expect(hold({ status: "open", unmetDeps: ["M-0"], assignee: "Ann" }), "a person's card: nobody to hold").toBe(false);
    expect(hold({ status: "open", unmetDeps: ["M-0"] }, { by: "instance", who: "beta" }), "a reply goes to the one it answers").toBe(false);
  });

  it("the ⋯ menu: each kind of viewer is offered what the board would let them do", () => {
    const labels = (entry: any, ctx: any) => thread.commentMenuItems(entry, ctx, () => {}).map((i: any) => i.key);
    const [q1, a1] = entries();
    const root = { writable: true, viewer: ANN, root: true, resolved: false };
    expect(labels(q1, root), "own comment, a thread's first").toEqual(["reply", "react", "edit", "resolve", "copy", "link", "delete"]);
    expect(labels(a1, { ...root, root: false }), "someone else's reply: no edit, no resolve").toEqual(["reply", "react", "copy", "link", "delete"]);
    expect(labels(q1, { ...root, resolved: true }).includes("resolve")).toBe(true);
    expect(thread.commentMenuItems(q1, { ...root, resolved: true }, () => {}).find((i: any) => i.key === "resolve").label).toBe("Reopen thread");
    expect(labels(q1, { writable: false, viewer: null, root: true }), "a read-only page").toEqual(["copy", "link"]);
    expect(labels(q1, { writable: true, viewer: null, root: true }), "no viewer to write as").toEqual(["copy", "link"]);
    expect(labels({ ...q1, deleted: { at: at(1), by: "Ann" } }, root), "a deleted one: only its link").toEqual(["resolve", "link"]);
    expect(labels({ ...q1, kind: "reject" }, root).includes("edit"), "a send-back is not edited").toBe(false);
  });
});

describe("1b. whose comment it is: the host says, the name is the fallback", () => {
  const edit = (entry: any, viewer: any = ANN) => thread.commentMenuItems(entry, { writable: true, viewer, root: true, resolved: false }, () => {}).some((i: any) => i.key === "edit");
  const base = () => activity.timelineOf({ comments: [c(11, "Ann", "person", "x")], logs: [], history: [] })[0];

  it("`mine` from the host decides: another person with the same name is not offered Edit; the same person under another name is", () => {
    expect(edit({ ...base(), mine: false })).toBe(false);
    expect(edit({ ...base(), mine: true }, { name: "Alex", kind: "person" })).toBe(true);
  });
  it("a host that does not say reads by name and kind, as before", () => {
    expect(edit(base())).toBe(true);
    expect(edit(base(), { name: "Bob", kind: "person" })).toBe(false);
  });
  it("the timeline keeps what the host said", () => {
    const tl = activity.timelineOf({ comments: [{ ...c(11, "Ann", "person", "x"), mine: true }, { ...c(12, "Ann", "person", "y"), mine: false }, c(13, "Ann", "person", "z")], logs: [], history: [] });
    expect(tl.map((e: any) => e.mine)).toEqual([true, false, undefined]);
  });
});

describe("2. the ⋯ menu on the page", () => {
  it("a thread is drawn under its first comment, indented; a comment of its own stays a card; tools sit in every head", async () => {
    await open();
    expect(qa(".tl-thread").length).toBe(1);
    expect(qa(".tl-thread .tl-reply").map((li) => li.id)).toEqual(["c12", "c13"]);
    expect(q("#c14").className).not.toContain("tl-reply");
    expect(qa(".tl-comment .tl-tools").length).toBe(4);
    expect(text(q("#c13 .tl-edited"))).toBe("edited");
    expect(q("#c11").getAttribute("data-comment")).toBe("11");
  });

  it("the author's menu: reply, reaction, edit, resolve, copy, copy link, delete — someone else's has no edit", async () => {
    await open();
    expect(await menuOf(11)).toEqual(["Reply", "Add reaction", "Edit", "Resolve thread", "Copy", "Copy link", "Delete"]);
    fire(comment(11).querySelector(".tl-menu > button"), "click"); await settle(4);          // closes it again
    expect(await menuOf(14), "alpha's comment, Ann viewing: a thread's first comment may be resolved by anyone, but not edited").toEqual(["Reply", "Add reaction", "Resolve thread", "Copy", "Copy link", "Delete"]);
  });

  it("a comment the host says is not the viewer's has no Edit, though the name is the viewer's (two accounts both named alike)", async () => {
    detail = detailOf({ comments: COMMENTS.map((e) => (e.id === 11 ? { ...e, mine: false } : e.id === 13 ? { ...e, mine: true } : e)) });
    await open();
    expect(await menuOf(11), "c11 is Ann's by name, not the viewer's").toEqual(["Reply", "Add reaction", "Resolve thread", "Copy", "Copy link", "Delete"]);
  });

  it("Edit opens the words in a box; Ctrl+Enter sends them, Esc drops the change", async () => {
    await open();
    await choose(11, "Edit");
    const box = q("#c11 .tl-edit textarea");
    expect(box.value).toBe("Is the **ranking** weekly?");
    await typeInto(box, "Is the leaderboard weekly?");
    fire(box, "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(q("#c11 .tl-edit"), "Esc closes the box").toBeNull();
    expect(posts()).toEqual([]);
    await choose(11, "Edit");
    await typeInto(q("#c11 .tl-edit textarea"), "Is the leaderboard weekly?");
    fire(q("#c11 .tl-edit textarea"), "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/11/edit", { text: "Is the leaderboard weekly?" }]]);
    expect(q("#c11 .tl-edit"), "closed once it is kept").toBeNull();
  });

  it("an unchanged edit sends nothing; a refused one keeps the box open", async () => {
    await open();
    await choose(11, "Edit");
    fire(qa("#c11 .tl-edit .btn").find((b) => text(b) === "Save"), "click"); await settle(8);
    expect(posts()).toEqual([]);
    handler = (path, method) => (method === "POST" ? { __status: 403, error: "only its author can edit comment c11", code: "forbidden", key: "comment_not_yours", args: ["c11"] } : path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: [card({})] } : detail);
    await choose(11, "Edit");
    await typeInto(q("#c11 .tl-edit textarea"), "rewritten");
    fire(q("#c11 .tl-edit textarea"), "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(q("#c11 .tl-edit textarea"), "refused: the words are still in the box").toBeTruthy();
    expect(q("#c11 .tl-edit textarea").value).toBe("rewritten");
  });

  it("Add reaction opens the quick set; a pick sends it; the viewer's own chip takes it back; a chip of others adds the viewer's", async () => {
    await open();
    await choose(11, "Add reaction");
    expect(qa(".tl-pick .react-opt").map((b) => text(b))).toEqual(["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🔥"]);
    fire(qa(".tl-pick .react-opt")[3], "click"); await settle(10);
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/11/react", { emoji: "🎉", on: true }]]);
    expect(q(".tl-pick"), "the set closes after a pick").toBeNull();
    // c14 carries 👍 from Ann (the viewer) and beta: pressed, count 2, who in the label
    const chip = q("#c14 .tl-reacts button");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(text(chip)).toBe("👍 2");
    expect(chip.getAttribute("aria-label")).toBe("You, beta reacted with 👍");
    calls.length = 0;
    fire(chip, "click"); await settle(10);
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/14/react", { emoji: "👍", on: false }]]);
    // a reaction the viewer has not put there: pressing adds theirs
    detail = detailOf({ comments: [...COMMENTS.slice(0, 3), { ...COMMENTS[3], reactions: [{ emoji: "🎉", by: [{ name: "beta", kind: "instance" }] }] }] });
    await open();
    calls.length = 0;
    const other = q("#c14 .tl-reacts button");
    expect(other.getAttribute("aria-pressed")).toBe("false");
    fire(other, "click"); await settle(10);
    expect(posts().map((x) => x.body)).toEqual([{ emoji: "🎉", on: true }]);
  });

  it("Resolve thread sends it for the first comment and folds the thread; a folded thread is one line that opens and Reopen sends the other way", async () => {
    await open();
    await choose(11, "Resolve thread");
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/11/resolve", { resolved: true }]]);
    // as the host now says it
    detail = detailOf({ comments: [{ ...COMMENTS[0], resolved: { at: at(6), by: "Ann" } }, ...COMMENTS.slice(1)] });
    await open();
    expect(qa(".tl-thread").length, "folded: no thread, one line").toBe(0);
    const line = q(".tl-resolved-btn");
    expect(text(line)!.replace(" :", ":"), "(the helper joins the pieces of a line with a space)").toBe("Resolved thread · Resolved by Ann · Ann: Is the **ranking** weekly? · 2 replies");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    fire(line, "click"); await settle(6);
    expect(qa(".tl-thread .tl-reply").length).toBe(2);
    expect(text(q(".tl-resolved-note"))).toContain("Resolved by Ann");
    calls.length = 0;
    await choose(11, "Reopen thread");
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/11/resolve", { resolved: false }]]);
  });

  it("Copy puts the comment's Markdown on the clipboard; Copy link its address with the anchor", async () => {
    await open();
    await choose(11, "Copy");
    expect(written).toEqual(["Is the **ranking** weekly?"]);
    await choose(12, "Copy link");
    expect(written[1]).toMatch(/\?.*card=M-1.*#c12$/);
    expect(new URL(written[1]!).hash).toBe("#c12");
  });

  it("Delete asks first; yes sends it, no sends nothing; a deleted comment is a line where it was, with its replies still under it", async () => {
    await open();
    (globalThis as any).confirm = () => false;
    await choose(11, "Delete");
    expect(posts()).toEqual([]);
    (globalThis as any).confirm = (m: string) => { written.push(`asked: ${m}`); return true; };
    await choose(11, "Delete");
    expect(written.at(-1)).toContain("Its words, reactions and files go.");
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1/comments/11/delete", {}]]);
    detail = detailOf({ comments: [{ ...COMMENTS[0], text: "", deleted: { at: at(7), by: "Ann" } }, ...COMMENTS.slice(1)] });
    await open();
    expect(text(q("#c11"))).toContain("This comment was deleted");
    expect(q("#c11 .tl-tools"), "nothing to do to a placeholder").toBeNull();
    expect(qa(".tl-thread .tl-reply").map((li) => li.id)).toEqual(["c12", "c13"]);
  });
});

describe("3. the recipient chip", () => {
  const chipText = () => text(q(".tc-composer .tc-to"));
  const chipItems = async (scope = ".tc-composer") => { fire(q(`${scope} .tc-to`), "click"); await settle(4); return qa(`${scope} .menu-list button, ${scope} .menu-list .menu-heading`).map((b) => text(b)); };
  const send = async (box: any, words: string) => { await typeInto(box, words); fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10); };

  it("starts as the card's assignee, 'dev · starts when sent'; Send carries it", async () => {
    await open();
    expect(chipText()).toBe("alpha · starts when sent");
    await send(q(".tc-composer textarea"), "please look");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "please look", to: ["alpha"] }]);
  });

  it("lists who else it may be for — the assignee, who handed it out, who watches, its leader, the rest; the task board's off ones are shown, not choosable; and 'No agent notified'", async () => {
    detail = detailOf({ card: card({ dispatcher: { kind: "instance", name: "beta" } }), watchers: ["quiet"], leader: { name: "alpha", via: "board" } });
    await open();
    expect(await chipItems()).toEqual(["Assignee", "alpha", "Handed out by", "beta", "Watching the card", "quiet (task board off)", "No agent notified"]);
    expect(qa(".tc-composer .menu-list button").find((b) => text(b)!.startsWith("quiet")).disabled).toBe(true);
  });

  it("a choice is what is sent: another instance, or nobody (to: []) — an @name in the words is still the board's business", async () => {
    await open();
    await chipItems();
    fire(qa(".tc-composer .menu-list button").find((b) => text(b) === "beta"), "click"); await settle(6);
    expect(chipText()).toBe("beta · starts when sent");
    await send(q(".tc-composer textarea"), "@alpha and you");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "@alpha and you", to: ["beta"] }]);
    calls.length = 0;
    await chipItems();
    fire(qa(".tc-composer .menu-list button").find((b) => text(b) === "No agent notified"), "click"); await settle(6);
    expect(chipText()).toBe("No agent notified");
    await send(q(".tc-composer textarea"), "just a note");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "just a note", to: [] }]);
  });

  it("a person's card, an unassigned one and a finished one start at 'No agent notified'", async () => {
    for (const over of [{ assignee: "Ann" }, { assignee: null }, { status: "done" }]) {
      detail = detailOf({ card: card(over) });
      await open();
      expect(chipText(), JSON.stringify(over)).toBe("No agent notified");
      calls.length = 0;
      await send(q(".tc-composer textarea"), "a word");
      expect(posts().map((x) => x.body), JSON.stringify(over)).toEqual([{ comment: "a word", to: [] }]);
    }
  });

  it("a card that still waits on another card: the chip names the assignee but says it is not woken until the card is ready, and Send carries no recipient list — #4367's rule; choosing the assignee asks for it by name", async () => {
    detail = detailOf({ card: card({ status: "open", unmetDeps: ["M-0"] }) });
    await open();
    expect(chipText()).toBe("alpha · won't wake until the card is ready");
    expect(q(".tc-composer .tc-to-text").getAttribute("title")).toContain("does not wake alpha yet");
    await send(q(".tc-composer textarea"), "heads up");
    expect(posts().map((x) => x.body), "no `to`: the board's old rule holds the comment until the card can start").toEqual([{ comment: "heads up" }]);
    // Choosing the assignee in the list is asking for it by name: the chip says it starts when sent, and `to` is sent.
    calls.length = 0;
    await chipItems();
    fire(qa(".tc-composer .menu-list button").find((b) => text(b) === "alpha"), "click"); await settle(6);
    expect(chipText()).toBe("alpha · starts when sent");
    await send(q(".tc-composer textarea"), "now please");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "now please", to: ["alpha"] }]);
  });

  it("on a waiting card another choice, or nobody, is sent as chosen; a card that waits on a card hidden from the viewer holds the name too", async () => {
    detail = detailOf({ card: card({ status: "open", unmetDeps: [], hiddenUnmet: 1 }) });
    await open();
    expect(chipText()).toBe("alpha · won't wake until the card is ready");
    await chipItems();
    fire(qa(".tc-composer .menu-list button").find((b) => text(b) === "beta"), "click"); await settle(6);
    expect(chipText()).toBe("beta · starts when sent");
    await send(q(".tc-composer textarea"), "to beta");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "to beta", to: ["beta"] }]);
    calls.length = 0;
    await chipItems();
    fire(qa(".tc-composer .menu-list button").find((b) => text(b) === "No agent notified"), "click"); await settle(6);
    await send(q(".tc-composer textarea"), "nobody");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "nobody", to: [] }]);
  });

  it("a card that is open with nothing left to wait for, or in progress, starts at the assignee as before", async () => {
    for (const over of [{ status: "open", unmetDeps: [] }, { status: "claimed", unmetDeps: [] }]) {
      detail = detailOf({ card: card(over) });
      await open();
      expect(chipText(), JSON.stringify(over)).toBe("alpha · starts when sent");
      calls.length = 0;
      await send(q(".tc-composer textarea"), "go");
      expect(posts().map((x) => x.body), JSON.stringify(over)).toEqual([{ comment: "go", to: ["alpha"] }]);
    }
  });

  it("an instance with the task board off, chosen by name in the words, is said under the box as before", async () => {
    await open();
    await typeInto(q(".tc-composer textarea"), "hello @quiet");
    expect(text(q(".tb-boardoff"))).toContain("quiet");
  });

  it("Reply opens a box under the thread whose chip starts as the one it answers; Send carries the comment's number and the recipient", async () => {
    await open();
    await choose(12, "Reply");                                      // alpha's answer: the reply goes to alpha
    const box = q(".tl-reply-box textarea");
    expect(box).toBeTruthy();
    expect(text(q(".tl-reply-box .tc-to"))).toBe("alpha · starts when sent");
    await send(box, "and tuesday?");
    expect(posts().map((x) => [x.path, x.body])).toEqual([["/ui/tasks/cards/M-1", { comment: "and tuesday?", replyTo: 12, to: ["alpha"] }]]);
    expect(q(".tl-reply-box"), "closed once it is sent").toBeNull();
    // a reply to a person's comment starts at the card's default; the chip may be changed in the box
    calls.length = 0;
    await choose(13, "Reply");
    expect(text(q(".tl-reply-box .tc-to"))).toBe("alpha · starts when sent");
    await chipItems(".tl-reply-box");
    fire(qa(".tl-reply-box .menu-list button").find((b) => text(b) === "No agent notified"), "click"); await settle(6);
    await send(q(".tl-reply-box textarea"), "noted");
    expect(posts().map((x) => x.body)).toEqual([{ comment: "noted", replyTo: 13, to: [] }]);
  });

  it("Esc, or Cancel, closes the reply box and sends nothing", async () => {
    await open();
    await choose(14, "Reply");
    await typeInto(q(".tl-reply-box textarea"), "never mind");
    fire(q(".tl-reply-box textarea"), "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(q(".tl-reply-box")).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe("4. a link to a comment", () => {
  it("scrolls to it and lights it for a moment", async () => {
    const seen: string[] = [];
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?card=M-1#c12");
    const proto = (globalThis as any).Element?.prototype;
    const was = proto?.scrollIntoView;
    if (proto) proto.scrollIntoView = function scrolled() { seen.push((this as any).id); };
    try {
      await p.unmount();
      (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
      await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|th-${++mounts}|en` }));
      await settle(14);
      expect(seen).toContain("c12");
      expect(q("#c12").className).toContain("tl-flash");
      expect(q("#c11").className).not.toContain("tl-flash");
    } finally { if (proto) proto.scrollIntoView = was; }
  });

  it("opens a resolved thread first", async () => {
    detail = detailOf({ comments: [{ ...COMMENTS[0], resolved: { at: at(6), by: "Ann" } }, ...COMMENTS.slice(1)] });
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?card=M-1#c13");
    await p.unmount();
    (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|th-${++mounts}|en` }));
    await settle(14);
    expect(q(".tl-resolved-btn"), "the line gave way to the thread").toBeNull();
    expect(q("#c13")).toBeTruthy();
  });

  it("a number that is no comment of this card lights nothing", async () => {
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?card=M-1#c999");
    await p.unmount();
    (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|th-${++mounts}|en` }));
    await settle(14);
    expect(qa(".tl-flash")).toEqual([]);
  });
});

describe("5. read only, and what a comment says", () => {
  it("a read-only page offers copy and the link only: no reply, edit, reaction, resolve or delete, no comment box, no pressable chips", async () => {
    doc().body.dataset.tier = "guest";
    detail = detailOf({ viewer: undefined });
    await open();
    expect(q(".tc-composer")).toBeNull();
    expect(await menuOf(11)).toEqual(["Copy", "Copy link"]);
    expect(q("#c14 .tl-reacts button"), "a chip is a label, not a button").toBeNull();
    expect(text(q("#c14 .tl-reacts .react-chip"))).toBe("👍 2");
    expect(qa(".tl-tools button.tl-tool"), "no reaction button").toEqual([]);
  });

  it("an admin session without a person to write as (the viewer is missing) is read-only too", async () => {
    detail = detailOf({ viewer: undefined });
    await open();
    expect(await menuOf(11)).toEqual(["Copy", "Copy link"]);
  });

  it("what a comment says is drawn escaped: markup in a comment, an edit or an emoji slot never becomes a tag", async () => {
    const nasty = "<img src=x onerror=\"globalThis.__xss = 1\"> <script>globalThis.__xss = 2</script> [x](javascript:globalThis.__xss=3)";
    detail = detailOf({ comments: [c(11, "Ann", "person", nasty, { editedAt: at(5) }), { ...c(12, "alpha", "instance", "ok"), reactions: [{ emoji: "<b>x</b>", by: [{ name: "<i>beta</i>", kind: "instance" }] }] }] });
    await open();
    const html = q("#c11").innerHTML ?? "";
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;img");
    expect(q("#c11 a[href^='javascript']")).toBeNull();
    expect(q("#c12 .tl-reacts b"), "no element made from an emoji slot").toBeNull();
    expect(q("#c12 .tl-reacts i")).toBeNull();
    expect(text(q("#c12 .tl-reacts .e")), "the text is the text").toBe("<b>x</b>");
    expect((globalThis as any).__xss).toBeUndefined();
  });
});

describe("6. what a finger presses on a touch screen or a phone is a 44px box", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/ui/shared/task-board.css", import.meta.url)), "utf8");
  const TOUCH = "@media (pointer: coarse), (max-width: 899px) {";
  it("a reaction chip you can press, the quick set's choices and the thread's text button take --tap; a chip that cannot be pressed stays as it was", () => {
    const at = css.indexOf(`${TOUCH}\n  .tl-reacts button.react-chip`);
    expect(at, "a touch / narrow block for the thread").toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toMatch(/\.tl-reacts button\.react-chip \{ min-height: var\(--tap\); min-width: var\(--tap\); \}/);
    expect(block).toMatch(/\.tl-pick \.react-opt \{ width: var\(--tap\); height: var\(--tap\); \}/);
    expect(block).toMatch(/\.tl-resolved-note \.tb-link \{[^}]*min-height: var\(--tap\)/);
    expect(block, "the chip that is not a button (a read-only page) is not in it").not.toMatch(/span\.react-chip/);
    expect(css, "no 32px chip left").not.toMatch(/\.tl-reacts \.react-chip \{ min-height: 32px/);
  });
});

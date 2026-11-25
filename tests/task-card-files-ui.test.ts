/**
 * The card's page shows what an agent put on it, through the real Tasks tab.
 *  - Markdown: a card's goal, scope, context, state, result and blocked reason are READ as the chat reads a message (lines, lists, code,
 *    links — escaped first: a tag is text, a javascript: link is no link); a click on the text opens the plain-text box as before; the
 *    box and the stored text are unchanged; a read-only page reads it too.
 *  - Files: under the comment they came with, and together in the card's Files field — the name is the download, an image is shown,
 *    Markdown / text open in place (read once, capped, never run), an .html file has Preview only where the chat would offer it.
 *  - the board's tiles show a paperclip with the count; both languages say it; no style attribute anywhere (the CSP).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let fleet: any, i18n: any, app: any, nav: any, files: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const FILE_BODIES = new Map<string, string>();
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path, body: o.body ? JSON.parse(o.body) : null });
  if (path.startsWith("/ui/tasks/files/")) {
    const body = FILE_BODIES.get(path.split("/").pop()!);
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = new TextEncoder().encode(body);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
  const out: any = await handler(path, method, o.body ? JSON.parse(o.body) : null);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const AT = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: "M-1", kind: "main", projectId: 1, parentId: null, title: "Survivors", status: "review", assignee: "alpha", dispatcher: { kind: "person", name: "Ann" },
  waitsForPerson: true, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "", acceptance: [] as Array<{ text: string; done: boolean }>, context: "", state: "", blockedReason: "",
  result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null, doneAt: null,
  progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, attachmentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Games", description: "", archived: false, sort: 1, createdAt: ago(30) };
const ID = { png: "1".repeat(32), md: "2".repeat(32), html: "3".repeat(32), zip: "4".repeat(32), big: "5".repeat(32) };
const file = (id: string, name: string, kind: string, size: number, entryId: number | null = 7) => ({ id, cardId: "M-1", entryId, name, mime: "x", kind, size, author: "alpha", authorKind: "instance", at: AT(5) });
const FILES = [file(ID.png, "shot.png", "photo", 2048), file(ID.md, "survivor-design.md", "document", 1234), file(ID.html, "index.html", "document", 20_480), file(ID.zip, "assets.zip", "document", 5 * 1024 * 1024)];

let CARDS: any[] = [];
let DETAIL: any = {};
const detail = (c: any) => ({ card: c, parent: null, children: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true, comments: [], logs: [], history: [], attachments: [], ...DETAIL });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  fleet = await import("/ui/js/panel-fleet.js");
  files = await import("/ui/js/fleet-task-files.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
afterEach(() => { delete (globalThis as any).AgendPreview; delete (globalThis as any).document.body.dataset.publicLink; delete (globalThis as any).document.body.dataset.linkMedia; });

beforeEach(async () => {
  await p.unmount();
  i18n.setLang("en", { store: false });
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0; FILE_BODIES.clear(); DETAIL = {};
  CARDS = [card({})];
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
    if (m && method === "GET") return detail(CARDS.find((x) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0]);
    return { card: CARDS[0], notes: [] };
  };
  app.applyStatus({ uptime: 1, instances: ["alpha"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount() {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|files-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
async function open(id = "M-1") { fire(q(`[data-tile="${id}"] .tb-tile-title`) ?? q(`[data-row="${id}"] .tb-row-title`), "click"); await settle(12); }
const fieldOf = (title: string) => qa(".tp-body .tc-field").find((f) => text(f.querySelector("h3")) === title);

describe("a card's text is read as Markdown", () => {
  it("lines, lists, headings, code and links are drawn; the stored text and the box that edits it are plain", async () => {
    CARDS = [card({ goal: "Why\n\n- one\n- two\n\nSee `index.html` and [the repo](https://example.com/r)", result: "## Done\n\n1. design\n2. prototype\n\n```js\nlet a = 1;\n```" })];
    await mount(); await open();
    const goal = fieldOf("Goal")!.querySelector(".tc-md");
    expect(goal, "the goal is the Markdown box").toBeTruthy();
    expect(goal.querySelectorAll("li").length).toBe(2);
    expect(text(goal.querySelector("code"))).toBe("index.html");
    expect(goal.querySelector("a").getAttribute("href")).toBe("https://example.com/r");
    expect(goal.querySelector("a").getAttribute("rel")).toContain("noopener");
    const result = fieldOf("Result")!.querySelector(".tc-md");
    expect(result.querySelectorAll("ol li").length).toBe(2);
    expect(result.querySelector("h3, h2, h4"), "a heading").toBeTruthy();
    expect(result.querySelector(".codeblock pre"), "a code block with the chat's frame").toBeTruthy();
    // The box that opens is the plain text, as it always was.
    fire(goal, "click"); await settle(6);
    const box = fieldOf("Goal")!.querySelector("textarea");
    expect(box.value).toBe("Why\n\n- one\n- two\n\nSee `index.html` and [the repo](https://example.com/r)");
  });

  it("a click on a link or a code block's buttons does not open the box; a click on the words does; the Edit button is the keyboard's way in", async () => {
    CARDS = [card({ goal: "Read [the repo](https://example.com/r) now" })];
    await mount(); await open();
    fire(fieldOf("Goal")!.querySelector(".tc-md a"), "click"); await settle(4);
    expect(fieldOf("Goal")!.querySelector("textarea"), "a link is a link").toBeNull();
    fire(fieldOf("Goal")!.querySelector(".tc-md-edit"), "click"); await settle(4);
    expect(fieldOf("Goal")!.querySelector("textarea")).toBeTruthy();
  });

  it("what the text says is escaped first: a tag is text, a javascript: link is not a link, an image tag is no image — and a read-only page reads it too", async () => {
    CARDS = [card({ state: "<script>alert(1)</script><img src=x onerror=alert(2)> [x](javascript:alert(3)) **bold**", status: "claimed" })];
    for (const readOnly of [false, true]) {
      (globalThis as any).document.body.dataset.publicLink = readOnly ? "1" : "";
      await mount(); await open();
      const body = fieldOf("State")!.querySelector(".tc-md");
      expect(body, `readOnly=${readOnly}`).toBeTruthy();
      expect(body.querySelector("script, img, iframe"), "no tag of the text's own").toBeNull();
      expect([...body.querySelectorAll("a")].filter((a) => /^javascript:/i.test(a.getAttribute("href") ?? ""))).toEqual([]);
      expect(body.querySelector("strong")).toBeTruthy();
      expect(text(body)).toContain("<script>alert(1)</script>");
    }
  });

  it("an empty field stays the quiet button, and a plain one-line text still reads as that line", async () => {
    CARDS = [card({ goal: "Players see their rank" })];
    await mount(); await open();
    expect(text(fieldOf("Goal")!.querySelector(".tc-text"))).toBe("Players see their rank");
    expect(qa(".tp-add").length).toBeGreaterThan(0);
  });
});

describe("files on the card", () => {
  const withFiles = () => {
    DETAIL = { comments: [{ id: 7, author: "alpha", authorKind: "instance", text: "## Design\n\nAll in the files.", at: AT(6) }], attachments: FILES };
    CARDS = [card({ attachmentCount: FILES.length, commentCount: 1 })];
  };

  it("under the comment they came with and in the Files field: the name is the download, the size and who are told, an image is shown", async () => {
    withFiles(); await mount(); await open();
    const under = qa(".tl-comment .tf-row");
    expect(under.map((r) => r.querySelector(".tf-name").textContent)).toEqual(["shot.png", "survivor-design.md", "index.html", "assets.zip"]);
    const link = under[1].querySelector("a.tf-name");
    expect(link.getAttribute("href")).toBe(`/ui/tasks/files/${ID.md}`);
    expect(link.getAttribute("download")).toBe("survivor-design.md");
    expect(text(under[1].querySelector(".tf-meta")), "a size, no author under its own comment").toMatch(/^\d/);
    const img = under[0].querySelector(".tf-img img");
    expect(img.getAttribute("src")).toBe(`/ui/tasks/files/${ID.png}`);
    expect(img.getAttribute("alt")).toBe("shot.png");
    const field = q(".tp-files");
    expect(text(field.querySelector("h3"))).toBe("Files 4");
    expect(field.querySelectorAll(".tf-row").length).toBe(4);
    expect(text(field.querySelector(".tf-meta"))).toContain("alpha");
    expect(qa("[style]").filter((el) => el.closest && el.closest(".tp"))).toEqual([]);
  });

  it("a card with no file has no Files field and no list; an entry id no comment has is shown in the field only", async () => {
    CARDS = [card({})]; await mount(); await open();
    expect(q(".tp-files")).toBeNull();
    expect(q(".tf-list")).toBeNull();
    DETAIL = { comments: [{ id: 7, author: "alpha", authorKind: "instance", text: "x", at: AT(6) }], attachments: [file(ID.zip, "assets.zip", "document", 10, 999)] };
    await mount(); await open();
    expect(qa(".tl-comment .tf-row").length).toBe(0);
    expect(qa(".tp-files .tf-row").length).toBe(1);
  });

  it("Show reads a Markdown file once (capped, same origin) and draws it as the chat does; text is plain; Hide folds it; nothing in it runs", async () => {
    withFiles();
    FILE_BODIES.set(ID.md, "# Survivors\n\n- WASD\n- <script>alert(1)</script>\n\n```js\nlet a;\n```");
    await mount(); await open();
    const row = qa(".tp-files .tf-row").find((r) => text(r.querySelector(".tf-name")) === "survivor-design.md")!;
    expect(row.querySelector(".tf-body"), "nothing is read until it is asked for").toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/files/"))).toEqual([]);
    fire(row.querySelector(".tf-text button"), "click"); await settle(12);
    expect(calls.filter((c) => c.path === `/ui/tasks/files/${ID.md}`)).toHaveLength(1);
    const body = row.querySelector(".tf-body");
    expect(body.querySelector("h1, h2, h3"), "Markdown").toBeTruthy();
    expect(body.querySelectorAll("li").length).toBe(2);
    expect(body.querySelector("script")).toBeNull();
    expect(text(body)).toContain("<script>alert(1)</script>");
    fire(row.querySelector(".tf-text button"), "click"); await settle(6);
    expect(row.querySelector(".tf-body")).toBeNull();
    fire(row.querySelector(".tf-text button"), "click"); await settle(6);
    expect(calls.filter((c) => c.path === `/ui/tasks/files/${ID.md}`), "read once, shown again").toHaveLength(1);
  });

  it("a file the fleet no longer serves says so; a file that is only a download has no Show and no Preview", async () => {
    withFiles(); await mount(); await open();
    const md = qa(".tp-files .tf-row").find((r) => text(r.querySelector(".tf-name")) === "survivor-design.md")!;
    fire(md.querySelector(".tf-text button"), "click"); await settle(12);
    expect(text(md.querySelector(".tf-note"))).toBe("This file is no longer available.");
    const zip = qa(".tp-files .tf-row").find((r) => text(r.querySelector(".tf-name")) === "assets.zip")!;
    expect(zip.querySelector(".tf-text, .tf-html, .tf-img")).toBeNull();
    expect(zip.querySelector("a.tf-dl").getAttribute("href")).toBe(`/ui/tasks/files/${ID.zip}`);
  });

  it("an .html file has Preview where the chat's sandbox is (this device allows it): the file is read and handed to the preview frame, never opened as a page", async () => {
    withFiles();
    FILE_BODIES.set(ID.html, "<!doctype html><canvas id=g></canvas><script>/* game */</script>");
    const start = vi.fn((_key: string, _holder: any, _code: string, ui: any, _opts?: unknown) => { ui.state("running", ""); return true; });
    const stop = vi.fn();
    (globalThis as any).AgendPreview = { availability: () => ({ ok: true }), start, stop, bannerAcked: () => true, banner: () => "b", bannerAckLabel: () => "ok", bannerAckTitle: () => "t", ackBanner() {} };
    await mount(); await open();
    const row = qa(".tp-files .tf-row").find((r) => text(r.querySelector(".tf-name")) === "index.html")!;
    expect(row.querySelector("iframe, object, embed")).toBeNull();
    fire(row.querySelector(".tf-html .btn-primary"), "click"); await settle(14);
    expect(calls.filter((c) => c.path === `/ui/tasks/files/${ID.html}`)).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe(`taskfile:${ID.html}`);
    expect(start.mock.calls[0]![2]).toBe("<!doctype html><canvas id=g></canvas><script>/* game */</script>");
    expect(start.mock.calls[0]![4], "fills a box of its own, not the automatic strip").toEqual({ fill: true });
    expect(text(row.querySelector(".tf-html .btn:not(.btn-primary)")), "running: Stop").toBe("Stop");
  });

  it("…and not over the public link (as the chat): the HTML is a download there, unless an admin session; nor where the page has no preview at all", async () => {
    withFiles();
    (globalThis as any).AgendPreview = { availability: () => ({ ok: true }), start: vi.fn(), stop: vi.fn(), bannerAcked: () => true, banner: () => "b", bannerAckLabel: () => "ok", bannerAckTitle: () => "t", ackBanner() {} };
    await mount();
    (globalThis as any).document.body.dataset.publicLink = "1";
    await open();
    expect(qa(".tp-files .tf-html").length).toBe(0);
    expect(qa(".tp-files a.tf-dl").length).toBe(4);
    await mount();
    (globalThis as any).document.body.dataset.publicLink = "1";
    (globalThis as any).document.body.dataset.linkMedia = "1";
    await open();
    expect(qa(".tp-files .tf-html").length).toBe(1);
    delete (globalThis as any).AgendPreview;
    await mount(); await open();
    expect(qa(".tp-files .tf-html").length).toBe(0);
  });

  it("a preview that no click can enable (no preview origin at this address, previews switched off) is said up front with no button; a device that only has not allowed them is asked on the click", async () => {
    withFiles();
    const stub = (availability: () => unknown) => { (globalThis as any).AgendPreview = { availability, start: vi.fn(), stop: vi.fn(), bannerAcked: () => true, banner: () => "b", bannerAckLabel: () => "ok", bannerAckTitle: () => "t", ackBanner() {} }; };
    const html = () => qa(".tp-files .tf-html").find((el) => el.querySelector(".tf-actions") !== null)!;
    stub(() => ({ ok: false, why: "server", reason: "Previews are not offered at https://x:8445: list this address in web.allowed_hosts, and set web.preview_origin." }));
    await mount(); await open();
    expect(html().querySelector(".btn-primary"), "no button to press").toBeNull();
    expect(text(html().querySelector(".tf-note"))).toContain("web.preview_origin");
    expect(qa(".tp-files a.tf-dl").length, "the download is there").toBe(4);
    stub(() => ({ ok: false, why: "optin", reason: "Previews are off on this device." }));
    await mount(); await open();
    expect(html().querySelector(".btn-primary"), "an opt-in is asked on the click").toBeTruthy();
    expect(text(html().querySelector(".tf-note"))).toBe("");
  });

  it("a device that does not allow previews is told so instead of running anything; a file whose id is not the fleet's is not drawn at all", async () => {
    withFiles();
    DETAIL.attachments = [...FILES, file("not-an-id", "evil.md", "document", 1), file(ID.big, "x</a><b>.md", "document", 1)];
    (globalThis as any).AgendPreview = { availability: () => ({ ok: false, why: "never", reason: "Previews are switched off on this device for this session." }), start: vi.fn(), stop: vi.fn(), bannerAcked: () => true, banner: () => "b", bannerAckLabel: () => "ok", bannerAckTitle: () => "t", ackBanner() {} };
    await mount(); await open();
    const row = qa(".tp-files .tf-row").find((r) => text(r.querySelector(".tf-name")) === "index.html")!;
    expect(row.querySelector(".tf-html .btn-primary"), "switched off for this session: no button").toBeNull();
    expect(text(row.querySelector(".tf-note"))).toBe("Previews are switched off on this device for this session.");
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/files/"))).toEqual([]);
    expect(qa(".tf-name").some((a) => a.textContent === "evil.md")).toBe(false);
    const odd = qa(".tf-name").find((a) => a.textContent.includes("x</a>"))!;           // a name is text, never markup
    expect(odd.querySelector("b")).toBeNull();
  });

  it("the board's tile carries a paperclip and the count; the Files field is said in Traditional Chinese too", async () => {
    withFiles(); await mount();
    const stats = q('[data-tile="M-1"] .tb-tile-stats');
    expect(text(stats)).toContain("4");
    expect(stats.querySelector('[title="Files"]')).toBeTruthy();
    i18n.setLang("zh-TW", { store: false });
    await mount(); await open();
    expect(text(q(".tp-files h3"))).toBe("檔案 4");
    expect(text(qa(".tp-files a.tf-dl")[0])).toBe("下載");
    expect(qa(".tp-files a.tf-dl")[0].getAttribute("aria-label")).toBe("下載: shot.png");
    i18n.setLang("en", { store: false });
  });

  it("previewKind: a picture, Markdown, text, HTML; media, archives and anything unknown are downloads", () => {
    const kind = (name: string, k = "document", id = ID.md) => files.previewKind({ id, name, kind: k });
    expect(kind("a.png", "photo")).toBe("image");
    expect(kind("a.md")).toBe("md");
    expect(["a.txt", "a.json", "a.csv", "a.py", "a.log"].map((n) => kind(n))).toEqual(["text", "text", "text", "text", "text"]);
    expect(["a.html", "A.HTM"].map((n) => kind(n))).toEqual(["html", "html"]);
    expect(["a.zip", "a.mp4", "a.mp3", "a", "a.exe"].map((n) => kind(n))).toEqual([null, null, null, null, null]);
    expect(kind("a.md", "document", "not-an-id")).toBeNull();
  });
});

describe("the sheet: nothing covers text, every control is a 44px box on a phone, a running preview has a box of its own", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/ui/shared/task-board.css", import.meta.url)), "utf8");
  const PHONE = "@media (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px) {";
  /** The body of every phone block (the canonical query), joined. */
  const phone = [...css.matchAll(/@media \(max-width: 899px\), \(pointer: coarse\) and \(max-height: 500px\) and \(max-width: 1023px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  const decl = (sel: string, from: string) => { const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(from); return m ? m[1]!.replace(/\s+/g, " ").trim() : null; };

  it("the Edit button: beside the text on the desk with room reserved for it, a row under the text on a phone, a 44px box on any touch screen", () => {
    expect(css).toContain(PHONE);
    expect(decl(".tc-md-edit", css)).toMatch(/position: absolute/);
    expect(decl(".tp .tc-md-wrap .tc-text", css), "room for the button: the text stops before it").toMatch(/padding-right: calc\(var\(--s-8\) \+ var\(--s-4\)\)/);
    expect(decl(".tc-md-edit", phone), "a phone: not over the text").toMatch(/position: static.*opacity: 1.*min-height: var\(--tap\)/);
    expect(decl(".tc-md-wrap", phone)).toMatch(/display: flex; flex-direction: column/);
    expect(decl(".tp .tc-md-wrap .tc-text", phone), "the room reserved on the desk is given back").toMatch(/padding-right: var\(--s-2\)/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.tc-md-edit \{ opacity: 1; min-width: var\(--tap\); min-height: var\(--tap\); \} \}/);
  });

  it("the file row's controls are 44px boxes on a phone; the card's preview has a fixed box, not the automatic strip", () => {
    expect(decl(".tf-dl, .tf-actions .btn, .tf-more", phone)).toMatch(/min-height: var\(--tap\)/);
    expect(decl(".tf-holder:not(:empty)", css)).toMatch(/display: flex; flex-direction: column; height: min\(75vh, 640px\); min-height: 260px/);
  });
});

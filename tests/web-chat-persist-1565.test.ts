/**
 * #1565 (baseline: issue comment 6097134242): the web chat history survives a fleet restart — the latest 500 per
 * instance, on the local disk, one private file per instance — with the cursor contract kept: a page that stayed
 * open across the restart is sent nothing it already shows, a fresh page gets the whole restored history. Restored
 * rows keep their role (never upgraded to agent) and nothing interactive (no buttons, no ticks); their files are
 * served again under their ids when they pass every ledger check (inside the instance's inbox, a regular file and
 * not a symlink, within MAX_SERVED_BYTES, never a pending upload) and shown as unavailable otherwise; an id leaves
 * the ledger with its message. Real WebChatHistory + WebChatDiskStore + WebFileLedger on a scratch directory;
 * FleetManager's restore on a scratch AGEND_HOME.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatHistory, type WebChatMessage } from "../src/web-chat-history.js";
import { WebChatDiskStore, WEB_CHAT_FILE, WEB_CHAT_FILE_MAX_BYTES } from "../src/web-chat-store.js";
import { MAX_SERVED_BYTES, publicAttachment, WebFileLedger } from "../src/web-upload.js";
// #1599: FleetManager's logger is a pino transport whose worker thread opens `<AGEND_HOME>/daemon.log` asynchronously —
// after the test that made it is over, racing afterEach's rmSync of the scratch home (CI: ENOTEMPTY). This file has no
// use for the log: the logger is silent, so nothing writes into the scratch home once a test's own work is done.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "agend-test-webchat-")); homes.push(h); return h; };
const OWNERS: Record<string, string> = { alpha: "dir:/w/alpha", beta: "dir:/w/beta" };
const store = (h: string, warn = vi.fn(), owners = OWNERS) => new WebChatDiskStore({ home: h, logger: { warn }, debounceMs: 5, ownerOf: (n) => owners[n] ?? null });
const fileOf = (h: string, instance: string) => join(h, "workspaces", instance, WEB_CHAT_FILE);
const inboxOf = (h: string, instance: string) => join(h, "workspaces", instance, "inbox");
/** The history's view of a ledger — as FleetManager.restoreWebChat wires it. */
const filesOf = (h: string, ledger: WebFileLedger) => ({
  storablePath: (id: string) => ledger.storablePath(id),
  restore: (e: { id: string; path: string; name: string; mime: string; kind: string }, instance: string) => ledger.restoreServed(e, instance, inboxOf(h, instance)),
  drop: (ids: string[]) => ledger.dropServed(ids),
});
/** One fleet process: a history with its store and its own file ledger (both start empty, as a process does). */
async function processWith(h: string, boot: string, instances = ["alpha", "beta"], opts: { perInstance?: number; perInstanceChars?: number } = {}) {
  const s = store(h);
  const ledger = new WebFileLedger();
  const hist = new WebChatHistory({ boot, ...opts });
  hist.setFiles(filesOf(h, ledger));
  for (const n of instances) hist.restore(n, s.load(n));
  hist.setStore(s);
  return { hist, s, ledger };
}
let clock = 0;   // wall time moves on across processes, as it does
const say = (hist: WebChatHistory, instance: string, text: string, extra: Record<string, unknown> = {}) =>
  hist.record({ instance, sender: extra.role === "agent" ? instance : "web-user", text, ts: new Date(Date.UTC(2026, 9, 10, 1, 0, 0) + ++clock).toISOString(), ...extra });
const put = (p: string, text = "hello") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); return p; };
const shape = (ms: WebChatMessage[]) => ms.map(m => `${m.boot}-${m.id}:${m.text}`);

// The page's own merge (chat-render.js), as served.
const R = (() => { const c = vm.createContext({}); vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8"), c); return (c as any).AgendChatRender; })();

describe("the history survives a restart", () => {
  it("a new process restores each instance's messages, in order, with the boot and id they had", async () => {
    const h = home();
    const p1 = await processWith(h, "aa");
    say(p1.hist, "alpha", "one"); say(p1.hist, "beta", "b-one"); say(p1.hist, "alpha", "two"); say(p1.hist, "alpha", "three");
    await p1.s.flush();
    const p2 = await processWith(h, "bb");
    expect([shape(p2.hist.list("alpha")), shape(p2.hist.list("beta"))]).toEqual([["aa-1:one", "aa-3:two", "aa-4:three"], ["aa-2:b-one"]]);
    // And on: a third process keeps both earlier processes' messages.
    say(p2.hist, "alpha", "four");
    await p2.s.flush();
    const p3 = await processWith(h, "cc");
    expect(shape(p3.hist.list("alpha"))).toEqual(["aa-1:one", "aa-3:two", "aa-4:three", "bb-1:four"]);
  });

  it("the bounds hold across it: the latest 500, and the text cap", async () => {
    const h = home();
    const p1 = await processWith(h, "aa");
    for (let i = 1; i <= 520; i++) say(p1.hist, "alpha", `m${i}`);
    await p1.s.flush();
    const p2 = await processWith(h, "bb");
    const kept = p2.hist.list("alpha");
    expect([kept.length, kept[0]!.text, kept.at(-1)!.text]).toEqual([500, "m21", "m520"]);
    const p3 = await processWith(h, "cc", ["alpha"], { perInstanceChars: 30 });
    expect(p3.hist.list("alpha").map(m => m.text)).toEqual(["m514", "m515", "m516", "m517", "m518", "m519", "m520"]);
  });
});

describe("no duplicates across a restart, and nothing missing", () => {
  async function restarted() {
    const h = home();
    const p1 = await processWith(h, "aa");
    say(p1.hist, "alpha", "one"); say(p1.hist, "alpha", "two"); say(p1.hist, "alpha", "three");
    await p1.s.flush();
    const p2 = await processWith(h, "bb");
    say(p2.hist, "alpha", "after-1"); say(p2.hist, "beta", "after-2");
    return p2.hist;
  }
  it("a page that stayed open (cursor aa-3) is sent only what came after it — the new process's messages", async () => {
    const hist = await restarted();
    expect(shape(hist.replayFor({ boot: "aa", id: 3 }))).toEqual(["bb-1:after-1", "bb-2:after-2"]);
    expect(shape(hist.replayFor({ boot: "aa", id: 2 }))).toEqual(["aa-3:three", "bb-1:after-1", "bb-2:after-2"]);
    // Merged by the page: no message twice, in order.
    const page = R.mergeMessages(hist.list("alpha").slice(0, 3), hist.replayFor({ boot: "aa", id: 3 }).filter((m: WebChatMessage) => m.instance === "alpha"));
    expect(page.map((m: WebChatMessage) => `${m.boot}-${m.id}`)).toEqual(["aa-1", "aa-2", "aa-3", "bb-1"]);
  });
  it("a fresh page gets the whole restored history (history and a cursor-less poll); a cursor of a boot it never held gets everything", async () => {
    const hist = await restarted();
    expect(shape(hist.list("alpha"))).toEqual(["aa-1:one", "aa-2:two", "aa-3:three", "bb-1:after-1"]);
    expect(shape(hist.after(0))).toEqual(["aa-1:one", "aa-2:two", "aa-3:three", "bb-1:after-1", "bb-2:after-2"]);
    expect(shape(hist.replayFor({ boot: "ffff", id: 9 }))).toEqual(["aa-1:one", "aa-2:two", "aa-3:three", "bb-1:after-1", "bb-2:after-2"]);
  });
  it("this process's cursor is compared with this process's ids only (a restored aa-3 is never 'newer' than bb-1)", async () => {
    const hist = await restarted();
    expect([shape(hist.after(1)), shape(hist.replayFor({ boot: "bb", id: 1 }))]).toEqual([["bb-2:after-2"], ["bb-2:after-2"]]);
  });
});

describe("restored as it is safe to show it", () => {
  async function restoredFrom(rows: unknown[], prep?: (h: string) => void) {
    const h = home();
    mkdirSync(inboxOf(h, "alpha"), { recursive: true });
    prep?.(h);
    writeFileSync(fileOf(h, "alpha"), JSON.stringify({ format: 1, instance: "alpha", owner: OWNERS.alpha, messages: rows }));
    const ledger = new WebFileLedger();
    const hist = new WebChatHistory({ boot: "bb" });
    hist.setFiles(filesOf(h, ledger));
    hist.restore("alpha", store(h).load("alpha"));
    return { ms: hist.list("alpha"), ledger, h };
  }
  const row = (id: number, extra: Record<string, unknown> = {}) => ({ boot: "aa", id, instance: "alpha", sender: "x", text: `t${id}`, ts: `2026-10-10T00:00:0${id}Z`, ...extra });
  it("roles as stored; anything else is a person's; never upgraded to agent", async () => {
    const { ms } = await restoredFrom([row(1, { role: "agent" }), row(2, { role: "status" }), row(3, { role: "user" }), row(4, { role: "admin" }), row(5)]);
    expect(ms.map(m => m.role)).toEqual(["agent", "status", "user", "user", "user"]);
  });
  it("nothing interactive comes back, whatever a row carries: no buttons, no tick, no message id", async () => {
    const { ms } = await restoredFrom([
      row(1, { role: "agent", buttons: { id: "a".repeat(32), labels: ["Yes", "No"], state: "open" } }),
      row(2, { role: "user", messageId: "web-1", delivery: "queued" }),
      row(3, { role: "user", messageId: "web-2", delivery: "delivered" }),
    ]);
    expect(ms.map(m => [m.buttons ?? null, m.delivery ?? null, m.messageId ?? null])).toEqual([[null, null, null], [null, null, null], [null, null, null]]);
  });
  it("rows not ours in shape are dropped; text is cut; a duplicate boot+id kept once", async () => {
    const { ms } = await restoredFrom([row(1), { ...row(2), boot: "../x" }, { ...row(3), id: -1 }, { ...row(4), instance: "beta" }, "junk", null, row(5, { text: "x".repeat(20_000) }), row(1)]);
    expect(ms.map(m => [m.id, m.text.length])).toEqual([[1, 2], [5, 16_000]]);
  });

  // Every ledger check on load: one case each, beside one that passes — each goes red when its check is removed.
  const ID = (c: string) => c.repeat(32);
  const att = (id: string, path: string, name = "f.txt") => ({ id, path, kind: "document", name, size: 5, mime: "text/plain; charset=utf-8" });
  /** One stored message with one file at `path(h)`, restored: what the page is shown, and what its id serves. */
  async function oneFile(path: (h: string) => string, id = ID("1")) {
    let p = "";
    const rows: unknown[] = [];
    const { ms, ledger } = await restoredFrom(rows, (h) => { p = path(h); rows.push(row(1, { attachments: [att(id, p)] })); });
    const r = ledger.read(id);
    // What the id serves, small enough to compare (an oversized file must never be served at all).
    return { a: ms[0]!.attachments![0]!, read: r ? (r.bytes.length <= 64 ? r.bytes.toString() : `${r.bytes.length} bytes`) : null };
  }
  const gone = (name = "f.txt") => ({ gone: true, kind: "document", name, size: 5, mime: "text/plain; charset=utf-8" });
  it("a file in the instance's inbox is served again under its id", async () => {
    const { a, read } = await oneFile((h) => put(join(inboxOf(h, "alpha"), "web-1-x.txt")));
    expect([a, read]).toEqual([{ id: ID("1"), kind: "document", name: "f.txt", size: 5, mime: "text/plain; charset=utf-8" }, "hello"]);
  });
  it("check: the real path is inside workspaces/<instance>/inbox — a file elsewhere (another instance's inbox too) is unavailable", async () => {
    const out = await oneFile((h) => put(join(h, "workspaces", "alpha", "notes.txt")));
    const other = await oneFile((h) => put(join(inboxOf(h, "beta"), "web-1-x.txt")));
    expect([out.a, out.read, other.a, other.read]).toEqual([gone(), null, gone(), null]);
  });
  it("check: the inbox itself is not a link elsewhere", async () => {
    const { a, read } = await oneFile((h) => {
      const elsewhere = join(h, "elsewhere");
      put(join(elsewhere, "web-1-x.txt"));
      rmSync(inboxOf(h, "alpha"), { recursive: true });
      symlinkSync(elsewhere, inboxOf(h, "alpha"));
      return join(inboxOf(h, "alpha"), "web-1-x.txt");
    });
    expect([a, read]).toEqual([gone(), null]);
  });
  it("check: not a symlink — even one to a file in the same inbox", async () => {
    const { a, read } = await oneFile((h) => {
      const real = put(join(inboxOf(h, "alpha"), "web-1-real.txt"));
      const link = join(inboxOf(h, "alpha"), "web-1-link.txt");
      symlinkSync(real, link);
      return link;
    });
    expect([a, read]).toEqual([gone(), null]);
  });
  it("check: a regular file — a directory under the name is unavailable", async () => {
    const { a, read } = await oneFile((h) => { const d = join(inboxOf(h, "alpha"), "web-1-dir.txt"); mkdirSync(d, { recursive: true }); return d; });
    expect([a, read]).toEqual([gone(), null]);
  });
  it("check: within MAX_SERVED_BYTES", async () => {
    const { a, read } = await oneFile((h) => { const p = put(join(inboxOf(h, "alpha"), "web-1-big.txt")); truncateSync(p, MAX_SERVED_BYTES + 1); return p; });
    expect([a, read]).toEqual([gone(), null]);
  });
  it("check: never a pending upload (web-pending-…), even one in the inbox", async () => {
    const { a, read } = await oneFile((h) => put(join(inboxOf(h, "alpha"), "web-pending-1-x.txt")));
    expect([a, read]).toEqual([gone(), null]);
  });
  it("check: an id of ours in shape", async () => {
    const { a } = await oneFile((h) => put(join(inboxOf(h, "alpha"), "web-1-x.txt")), "not-an-id");
    expect(a).toEqual(gone());
  });
  it("a missing file is unavailable: the name shown, no link", async () => {
    const { a, read } = await oneFile((h) => join(inboxOf(h, "alpha"), "web-1-deleted.txt"));
    expect([a, read]).toEqual([gone(), null]);
    const html = R.attachmentsHtml([a], { htmlCards: true, goneTitle: "why", goneLabel: "unavailable" });
    expect([/href=|\/ui\/file\//.test(html), /html-card/.test(html), /f\.txt/.test(html), /unavailable/.test(html)]).toEqual([false, false, true, true]);
  });
  it("check: the file checked is the file served — one swapped in while it is registered is refused", async () => {
    const h = home();
    const p = put(join(inboxOf(h, "alpha"), "web-1-x.txt"));
    const ledger = new WebFileLedger();
    const register = ledger.registerServed.bind(ledger);
    vi.spyOn(ledger, "registerServed").mockImplementation((input) => {
      put(join(inboxOf(h, "alpha"), "swap.txt"), "other");
      renameSync(join(inboxOf(h, "alpha"), "swap.txt"), p);       // another file (inode) under the checked name
      return register(input);
    });
    expect([ledger.restoreServed({ id: ID("1"), path: p }, "alpha", inboxOf(h, "alpha")), ledger.read(ID("1"))]).toEqual([null, null]);
  });
});

describe("files across a restart", () => {
  /** A web upload as /ui/upload + /ui/send make it: stored pending, taken by a message (renamed), delivered. */
  function upload(ledger: WebFileLedger, h: string, instance: string, text: string) {
    const e = ledger.storeUpload({ instance, inboxDir: inboxOf(h, instance), bytes: Buffer.from(text), name: `${text}.txt`, type: { ext: ".txt", kind: "document", mime: "text/plain; charset=utf-8" } as any });
    return e;
  }
  function sent(ledger: WebFileLedger, h: string, instance: string, text: string) {
    const e = upload(ledger, h, instance, text);
    const taken = ledger.takeForMessage(instance, [e.id]);
    if (!taken.ok) throw new Error(taken.error);
    ledger.commit(taken.entries);
    return publicAttachment(e);
  }
  it("an upload a message sent, and a file an agent attached from the inbox, still open after the restart — by the same id", async () => {
    const h = home();
    const p1 = await processWith(h, "aa");
    const up = sent(p1.ledger, h, "alpha", "from-user");
    const agentFile = p1.ledger.registerServed({ path: put(join(inboxOf(h, "alpha"), "report.txt"), "from-agent"), instance: "alpha" })!;
    say(p1.hist, "alpha", "see file", { attachments: [up] });
    say(p1.hist, "alpha", "here", { role: "agent", attachments: [publicAttachment(agentFile)] });
    await p1.s.flush();
    const p2 = await processWith(h, "bb");
    const shown = p2.hist.list("alpha").map(m => m.attachments![0]!);
    expect(shown).toEqual([publicAttachment(up), publicAttachment(agentFile)]);
    expect([p2.ledger.read(up.id)?.bytes.toString(), p2.ledger.read(agentFile.id)?.bytes.toString()]).toEqual(["from-user", "from-agent"]);
  });
  it("a pending upload is never kept: no path on disk, unavailable after the restart", async () => {
    const h = home();
    const p1 = await processWith(h, "aa");
    const e = upload(p1.ledger, h, "alpha", "waiting");
    say(p1.hist, "alpha", "x", { attachments: [publicAttachment(e)] });
    await p1.s.flush();
    expect([readFileSync(fileOf(h, "alpha"), "utf8").includes("web-pending-"), readFileSync(fileOf(h, "alpha"), "utf8").includes(e.id)]).toEqual([false, false]);
    const p2 = await processWith(h, "bb");
    expect([p2.hist.list("alpha")[0]!.attachments, p2.ledger.read(e.id)]).toEqual([[{ gone: true, kind: "document", name: "waiting.txt", size: 7, mime: "text/plain; charset=utf-8" }], null]);
  });
  it("no buttons, ticks or message ids are written", async () => {
    const h = home();
    const p = await processWith(h, "aa");
    say(p.hist, "alpha", "hi", { role: "agent", buttons: { id: "d".repeat(32), labels: ["Go"], values: ["v-secret"] } });
    say(p.hist, "alpha", "me", { messageId: "web-zz-1" });
    p.hist.setDelivery("alpha", "web-zz-1", "processing");
    await p.s.flush();
    const rows = JSON.parse(readFileSync(fileOf(h, "alpha"), "utf8")).messages as Array<Record<string, unknown>>;
    expect(rows.map(r => Object.keys(r).sort())).toEqual([["boot", "id", "instance", "role", "sender", "text", "ts"], ["boot", "id", "instance", "role", "sender", "text", "ts"]]);
  });
  it("an id leaves with its message when it falls out of the window — before and after a restart", async () => {
    const h = home();
    const p1 = await processWith(h, "aa", ["alpha"], { perInstance: 2 });
    const files = ["f1", "f2", "f3"].map(t => sent(p1.ledger, h, "alpha", t));
    say(p1.hist, "alpha", "1", { attachments: [files[0]] }); say(p1.hist, "alpha", "2", { attachments: [files[1]] });
    expect(p1.ledger.read(files[0]!.id)).not.toBeNull();
    say(p1.hist, "alpha", "3", { attachments: [files[2]] });
    expect(files.map(f => p1.ledger.read(f.id)?.bytes.toString() ?? null)).toEqual([null, "f2", "f3"]);
    await p1.s.flush();
    const p2 = await processWith(h, "bb", ["alpha"], { perInstance: 2 });
    say(p2.hist, "alpha", "4");
    expect(files.map(f => p2.ledger.read(f.id)?.bytes.toString() ?? null)).toEqual([null, null, "f3"]);
  });
  it("forget() takes the instance's ids with it (and leaves another instance's)", async () => {
    const h = home();
    const p = await processWith(h, "aa");
    const a = sent(p.ledger, h, "alpha", "a"), b = sent(p.ledger, h, "beta", "b");
    say(p.hist, "alpha", "x", { attachments: [a] }); say(p.hist, "beta", "y", { attachments: [b] });
    p.hist.forget("alpha");
    expect([p.ledger.read(a.id), p.ledger.read(b.id)?.bytes.toString()]).toEqual([null, "b"]);
  });
});

describe("the file", () => {
  it("is private (0600), written by a rename (no partial file is ever the file), and holds no button values", async () => {
    const h = home();
    const p = await processWith(h, "aa");
    say(p.hist, "alpha", "hi", { role: "agent", buttons: { id: "d".repeat(32), labels: ["Go"], values: ["v-secret"] } });
    await p.s.flush();
    const f = fileOf(h, "alpha");
    expect([statSync(f).mode & 0o777, readdirSync(join(h, "workspaces", "alpha")).filter(n => n.includes(".tmp-")), readFileSync(f, "utf8").includes("v-secret")]).toEqual([0o600, [], false]);
  });
  it("a corrupt, oversized, foreign or another owner's file is skipped with a log line — the instance starts empty", () => {
    const h = home();
    const warn = vi.fn();
    const put = (name: string, text: string) => { mkdirSync(join(h, "workspaces", name), { recursive: true }); writeFileSync(fileOf(h, name), text); };
    const owners = { a: "dir:/a", b: "dir:/b", c: "dir:/c", d: "dir:/d" };
    put("a", "{ not json");
    put("b", JSON.stringify({ format: 1, instance: "zzz", owner: "dir:/b", messages: [] }));
    put("c", JSON.stringify({ format: 1, instance: "c", owner: "dir:/elsewhere", messages: [] }));
    put("d", "x".repeat(WEB_CHAT_FILE_MAX_BYTES + 1));
    const s = store(h, warn, owners);
    expect(["a", "b", "c", "d", "none"].map(n => s.load(n))).toEqual([null, null, null, null, null]);
    expect(warn).toHaveBeenCalledTimes(4);
  });
  it("forget() deletes it, and a write still pending never brings it back", async () => {
    const h = home();
    const p = await processWith(h, "aa");
    say(p.hist, "alpha", "one");
    await p.s.flush();
    expect(existsSync(fileOf(h, "alpha"))).toBe(true);
    say(p.hist, "alpha", "two");                         // pending
    p.hist.forget("alpha");
    await p.s.flush(); await new Promise(r => setTimeout(r, 30)); await p.s.flush();
    expect(existsSync(fileOf(h, "alpha"))).toBe(false);
  });
  it("an instance name that is not a safe directory name is never written", async () => {
    const h = home();
    const s = new WebChatDiskStore({ home: h, logger: { warn: vi.fn() }, debounceMs: 1, ownerOf: () => "x" });
    const hist = new WebChatHistory({ boot: "aa", store: s });
    say(hist, "../evil", "x");
    await s.flush();
    expect([existsSync(join(h, "evil")), existsSync(join(h, "workspaces"))]).toEqual([false, false]);
  });
});

describe("the fleet restores the configured instances only", () => {
  it("fleet.yaml's instances are restored; a file of a name no longer configured is left alone (not shown)", async () => {
    const h = home();
    vi.stubEnv("AGEND_HOME", h);
    for (const [name, owner] of [["alpha", "dir:/w/alpha"], ["ghost", "dir:/w/ghost"]] as const) {
      mkdirSync(join(h, "workspaces", name), { recursive: true });
      writeFileSync(fileOf(h, name), JSON.stringify({ format: 1, instance: name, owner, messages: [{ boot: "aa", id: 1, instance: name, sender: "x", text: "kept", ts: "2026-10-10T00:00:00Z", role: "user" }] }));
    }
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(h) as any;
    clearInterval(fm.sessionPruneTimer);
    const fid = "e".repeat(32);
    const kept = put(join(h, "workspaces", "alpha", "inbox", "web-1-kept.txt"), "kept file");
    const rows = JSON.parse(readFileSync(fileOf(h, "alpha"), "utf8"));
    rows.messages[0].attachments = [{ id: fid, path: kept, kind: "document", name: "kept.txt", size: 9, mime: "text/plain" }];
    writeFileSync(fileOf(h, "alpha"), JSON.stringify(rows));
    const fleet = { defaults: {}, instances: { alpha: { working_directory: "/w/alpha" } } };
    fm.fleetConfig = fleet;
    fm.restoreWebChat(fleet);
    expect([fm.webChatHistory.list("alpha").map((m: WebChatMessage) => m.text), fm.webChatHistory.list("ghost"), existsSync(fileOf(h, "ghost"))]).toEqual([["kept"], [], true]);
    expect(lstatSync(fileOf(h, "alpha")).isFile()).toBe(true);
    // Its file is served again by the fleet's own ledger, by id.
    expect(fm.webFiles.read(fid)?.bytes.toString()).toBe("kept file");
    // #1599: quiescent before cleanup — the store's writes are done, and nothing else appears in the scratch home
    // afterwards (a late writer there is what made afterEach's rmSync fail with ENOTEMPTY).
    await fm.webChatStore?.flush();
    const listing = () => (readdirSync(h, { recursive: true }) as string[]).sort();
    const settled = listing();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(listing()).toEqual(settled);
  });
});

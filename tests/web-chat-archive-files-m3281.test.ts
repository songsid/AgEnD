/**
 * M-3281 (the user, 2026-11-17: an archived message keeps its files and pictures): as a message leaves the 500-message
 * window, each file it still served is kept by the archive (web-chat-archive.ts `files/`: a hard link, a copy across
 * devices) under an id of its own; a page reading the archived message gets it from there (the ledger's checks). Every
 * agent's kept files together stay within `web.chat_archive.files_max_gb` (default 5 GiB; 0 keeps none), the oldest
 * removed first — their messages then show the file as no longer kept; `retention_days` (off by default) takes a
 * month's files with its lines; removing an agent removes its files. A file the web chat still shows survives the
 * 7-day inbox rotation, so it is there to keep. Scratch homes and fake files only.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_FILES_MAX_GB, WebChatArchive } from "../src/web-chat-archive.js";
import { WebChatHistory, type WebChatMessage } from "../src/web-chat-history.js";
import { KEPT_SERVED_MAX, WebFileLedger } from "../src/web-upload.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "chat-archive-files-3281-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const NOV = Date.UTC(2026, 10, 17, 9, 0, 0), OCT = Date.UTC(2026, 9, 10, 9, 0, 0);
const KIB = 1024, GIB = 1024 ** 3;

function world(o: { gb?: number; days?: number; per?: number } = {}) {
  const home = tmp();
  let now = NOV;
  const log = { warn: vi.fn(), debug: vi.fn() };
  const ledger = new WebFileLedger();
  const archive = new WebChatArchive({ home, ownerOf: (n) => `dir:/w/${n}`, logger: log, now: () => now, retentionDays: () => o.days, filesMaxGb: () => o.gb });
  const h = new WebChatHistory({ perInstance: o.per ?? 2, boot: "b0" });
  h.setFiles({
    storablePath: (id) => ledger.storablePath(id),
    restore: () => null,
    drop: (ids) => ledger.dropServed(ids),
    keep: (id, dest) => ledger.keepCopy(id, dest),
    restoreKept: (entry, instance, keptDir) => ledger.restoreKept(entry, instance, keptDir),
  });
  h.setArchive(archive);
  const ws = (inst: string, sub: string) => { const d = join(home, "workspaces", inst, sub); mkdirSync(d, { recursive: true }); return d; };
  /** A file the chat shows: an inbox file (an upload), or (snapshot) a reply file's copy the ledger deletes with its message. */
  const file = (inst: string, name: string, bytes: number | string, snapshot = false) => {
    const path = join(ws(inst, snapshot ? "web-files" : "inbox"), name);
    writeFileSync(path, typeof bytes === "string" ? bytes : "x".repeat(bytes));
    return ledger.registerServed({ path, instance: inst, name, ...(snapshot ? { snapshot } : {}) })!;
  };
  let n = 0;
  const say = (inst: string, files: Array<{ id: string; kind: "photo" | "document"; name: string; size: number; mime: string }> = []) =>
    h.record({ instance: inst, sender: inst, role: "agent", text: `m${++n}`, ts: new Date(now + n * 1000).toISOString(),
      ...(files.length ? { attachments: files.map(f => ({ id: f.id, kind: f.kind, name: f.name, size: f.size, mime: f.mime })) } : {}) } as never);
  /** The archived messages, oldest first, as the page reads them (GET /ui/history/older from the window's first). */
  const archived = (inst: string): WebChatMessage[] => {
    const first = h.list(inst, 1000)[0]!;
    return h.older(inst, `${first.boot}-${first.id}`, 100)!.messages;
  };
  const kept = (inst: string) => { const d = join(home, "workspaces", inst, "web-chat-archive", "files"); return existsSync(d) ? readdirSync(d).flatMap(m => readdirSync(join(d, m)).map(f => `${m}/${f}`)) : []; };
  return { home, ledger, archive, h, file, say, archived, kept, log, setNow: (t: number) => { now = t; } };
}

describe("an archived message keeps its files", () => {
  it("an upload (inbox) and a reply's snapshot: kept as the message leaves the window, served under new ids from the archive — the same bytes", async () => {
    const w = world();
    const up = w.file("alpha", "notes.txt", "uploaded notes"), snap = w.file("alpha", "chart.png", "a reply's picture", true);
    w.say("alpha", [up, snap]);
    w.say("alpha"); w.say("alpha");                                       // a window of 2: the first message is archived
    await w.archive.flush();
    // The window let go of them: the old ids are no longer served, the snapshot's own file deleted (as before).
    expect([w.ledger.servedFile(up.id), w.ledger.servedFile(snap.id), existsSync(snap.realPath)]).toEqual([null, null, false]);
    expect(w.kept("alpha")).toHaveLength(2);
    const [m] = w.archived("alpha");
    const files = m!.attachments as Array<{ id: string; name: string; gone?: true }>;
    expect(files.map(f => [f.name, "gone" in f, f.id !== up.id && f.id !== snap.id])).toEqual([["notes.txt", false, true], ["chart.png", false, true]]);
    expect(files.map(f => w.ledger.read(f.id)?.bytes.toString())).toEqual(["uploaded notes", "a reply's picture"]);
    // The upload: a hard link to the inbox file (no space taken while the original lives) — the 7-day rotation then
    // removing the original does not take the archived copy.
    expect(statSync(up.realPath).ino).toBe(statSync(w.ledger.servedFile(files[0]!.id)!.realPath).ino);
    rmSync(up.realPath);
    expect(w.ledger.read(files[0]!.id)?.bytes.toString()).toBe("uploaded notes");
  });

  it("the archive line names the file by its new id and kept name only — never a path; read again after a restart (a fresh ledger), served again", async () => {
    const w = world();
    const up = w.file("alpha", "a.txt", "aaa");
    w.say("alpha", [up]); w.say("alpha"); w.say("alpha");
    await w.archive.flush();
    const text = readdirSync(join(w.home, "workspaces", "alpha", "web-chat-archive")).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(join(w.home, "workspaces", "alpha", "web-chat-archive", f), "utf8")).join("");
    const att = JSON.parse(text.split("\n")[0]!).attachments[0];
    expect(Object.keys(att).sort()).toEqual(["file", "id", "kind", "mime", "name", "size"]);
    expect(att.file).toMatch(new RegExp(`^2026-11/\\d{13}-${att.id}$`));
    expect(text).not.toContain(w.home);
    // A fresh ledger (the fleet restarted): the page's read serves it again under the same id.
    const fresh = new WebFileLedger();
    w.h.setFiles({ storablePath: () => null, restore: () => null, drop: () => {}, keep: (id, d) => fresh.keepCopy(id, d), restoreKept: (e, i, k) => fresh.restoreKept(e, i, k) });
    const [m] = w.archived("alpha");
    expect([(m!.attachments![0] as { id: string }).id, fresh.read(att.id)?.bytes.toString()]).toEqual([att.id, "aaa"]);
  });

  it("a line's file that is not the archive's own shape (a path, another id, `..`) is shown as gone, never served", async () => {
    const w = world();
    w.say("alpha"); w.say("alpha"); w.say("alpha");
    await w.archive.flush();
    const dir = join(w.home, "workspaces", "alpha", "web-chat-archive");
    const secret = join(w.home, "secret.txt"); writeFileSync(secret, "not yours");
    const id = "e".repeat(32);
    const bad = [{ id, file: secret }, { id, file: `2026-11/${"1".repeat(13)}-${"f".repeat(32)}` }, { id, file: `../../${"1".repeat(13)}-${id}` }, { id: "../x", file: `2026-11/${"1".repeat(13)}-${id}` }];
    writeFileSync(join(dir, "2026-10.jsonl"), bad.map((b, i) => JSON.stringify({ key: `b0-${90 + i}`, role: "agent", sender: "x", text: "t", ts: new Date(OCT).toISOString(), attachments: [{ ...b, kind: "document", name: "s.txt", size: 9, mime: "text/plain" }] })).join("\n") + "\n");
    const ms = w.h.older("alpha", "b0-1", 100)!.messages;
    expect(ms.map(m => (m.attachments![0] as { gone?: true }).gone)).toEqual([true, true, true, true]);
    expect(w.ledger.servedFile(id)).toBeNull();
  });

  it("files_max_gb: every agent's kept files together; past it the oldest go first (any agent), and their messages show the file as no longer kept", async () => {
    const w = world({ gb: (2.5 * KIB) / GIB });                          // room for two 1 KiB files
    const f1 = w.file("alpha", "one.bin", KIB);
    w.say("alpha", [f1]); w.say("alpha"); w.say("alpha");               // alpha's file kept (the oldest)
    w.setNow(NOV + 60_000);
    const f2 = w.file("beta", "two.bin", KIB);
    w.say("beta", [f2]); w.say("beta"); w.say("beta");
    w.setNow(NOV + 120_000);
    const f3 = w.file("beta", "three.bin", KIB);
    w.say("beta", [f3]); w.say("beta"); w.say("beta");                  // a third: alpha's (the oldest) goes
    await w.archive.flush();
    expect([w.kept("alpha").length, w.kept("beta").length]).toEqual([0, 2]);
    const a = w.archived("alpha").find(m => m.attachments?.length)!;
    expect(a.attachments![0]).toEqual({ gone: true, kind: "document", name: "one.bin", size: KIB, mime: "application/octet-stream" });
    expect(a.archived, "the page labels it no longer kept (an archived message's gone file)").toBe(true);
    expect(w.archived("beta").filter(m => m.attachments?.length).map(m => "gone" in m.attachments![0]!)).toEqual([false, false]);
  });

  it("files_max_gb lowered (agend reload): enforced at the next check; unset is 5 GiB; 0 keeps no files (named only, no files folder)", async () => {
    let gb: number | undefined;
    const home = tmp();
    const a = new WebChatArchive({ home, ownerOf: (n) => `dir:/w/${n}`, logger: { warn: vi.fn() }, now: () => NOV, filesMaxGb: () => gb });
    const big = () => a.keepFile("alpha", (dest) => { writeFileSync(dest, "y".repeat(KIB)); return true; });
    expect([big(), big(), big()].every(Boolean)).toBe(true);
    expect(a.enforceFilesCap(), "unset: 5 GiB").toBe(0);
    expect(ARCHIVE_FILES_MAX_GB).toBe(5);
    gb = KIB / GIB;
    expect(a.enforceFilesCap()).toBe(2);
    gb = 0;
    expect(a.keepFile("beta", (dest) => { writeFileSync(dest, "z"); return true; })).toBeNull();
    expect(existsSync(join(home, "workspaces", "beta", "web-chat-archive"))).toBe(false);
    const w = world({ gb: 0 });
    const f = w.file("alpha", "n.txt", "n");
    w.say("alpha", [f]); w.say("alpha"); w.say("alpha");
    await w.archive.flush();
    expect([w.kept("alpha"), (w.archived("alpha")[0]!.attachments![0] as { gone?: true }).gone]).toEqual([[], true]);
  });

  it("retention_days (off by default): a month past it goes with its kept files; unset keeps them", async () => {
    const w = world({ days: 30 });
    w.setNow(OCT);
    const f = w.file("alpha", "old.txt", "old");
    w.say("alpha", [f]); w.say("alpha"); w.say("alpha");
    await w.archive.flush();
    expect(w.kept("alpha")).toHaveLength(1);
    w.setNow(Date.UTC(2026, 11, 15));                                     // December: October ended more than 30 days ago
    expect(w.archive.prune("alpha")).toEqual(["2026-10.jsonl"]);
    expect(w.kept("alpha")).toEqual([]);
    const keep = world();
    keep.setNow(OCT);
    const g = keep.file("alpha", "old.txt", "old");
    keep.say("alpha", [g]); keep.say("alpha"); keep.say("alpha");
    await keep.archive.flush();
    keep.setNow(Date.UTC(2027, 11, 15));
    expect([keep.archive.prune("alpha"), keep.kept("alpha").length]).toEqual([[], 1]);
  });

  it("removing the agent removes its kept files (with its archive); another agent's stay", async () => {
    const w = world();
    for (const inst of ["alpha", "beta"]) { const f = w.file(inst, "f.txt", inst); w.say(inst, [f]); w.say(inst); w.say(inst); }
    await w.archive.flush();
    w.h.forget("alpha"); await w.archive.flush(); await new Promise(r => setTimeout(r, 10));
    expect([existsSync(join(w.home, "workspaces", "alpha", "web-chat-archive")), w.kept("beta").length]).toEqual([false, 1]);
  });

  it("an archived file read again is the same entry; the kept files have a served cap of their own (the chat's files are never pushed out)", () => {
    const home = tmp(), ledger = new WebFileLedger({ maxServed: 3 });
    const keptDir = join(home, "workspaces", "alpha", "web-chat-archive", "files"), month = join(keptDir, "2026-11");
    mkdirSync(month, { recursive: true });
    const chat = [1, 2, 3].map(i => { const p = join(home, `c${i}`); writeFileSync(p, `c${i}`); return ledger.registerServed({ path: p, instance: "alpha" })!; });
    const id = "a".repeat(32), path = join(month, `${"1".repeat(13)}-${id}`);
    writeFileSync(path, "kept");
    const one = ledger.restoreKept({ id, path, name: "k.txt", mime: "text/plain", kind: "document" }, "alpha", keptDir);
    expect(ledger.restoreKept({ id, path, name: "k.txt", mime: "text/plain", kind: "document" }, "alpha", keptDir)).toBe(one);
    expect(chat.every(c => ledger.servedFile(c.id)), "the chat's 3 still served").toBe(true);
    expect([one!.kept, KEPT_SERVED_MAX]).toEqual([true, 2000]);
    // Never another file's id, never outside the kept tree.
    expect(ledger.restoreKept({ id: chat[0]!.id, path, name: "x", mime: "text/plain", kind: "document" }, "alpha", keptDir)).toBeNull();
    writeFileSync(join(home, "outside"), "no");
    expect(ledger.restoreKept({ id: "b".repeat(32), path: join(home, "outside"), name: "x", mime: "text/plain", kind: "document" }, "alpha", keptDir)).toBeNull();
    // Pruned meanwhile: no longer served.
    rmSync(path);
    expect([ledger.restoreKept({ id, path, name: "k.txt", mime: "text/plain", kind: "document" }, "alpha", keptDir), ledger.servedFile(id)]).toEqual([null, null]);
  });
});

describe("the 7-day inbox rotation leaves a file the web chat still shows", () => {
  it("an old inbox file the chat shows stays; an old one it does not show goes (as before)", async () => {
    const home = tmp();
    vi.stubEnv("AGEND_HOME", home);
    const inbox = join(home, "workspaces", "alpha", "inbox");
    mkdirSync(inbox, { recursive: true });
    const shown = join(inbox, "shown.txt"), stray = join(inbox, "stray.txt");
    writeFileSync(shown, "s"); writeFileSync(stray, "t");
    const old = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(shown, old, old); utimesSync(stray, old, old);
    const webFiles = new WebFileLedger();
    webFiles.registerServed({ path: shown, instance: "alpha" });
    const { FleetManager } = await import("../src/fleet-manager.js");
    const deleted = (FleetManager.prototype as any).rotateInboxes.call({ dataDir: join(home, "data"), webFiles, logger: { info() {} } });
    expect([deleted, existsSync(shown), existsSync(stray)]).toEqual([1, true, false]);
  }, 120_000);                                                             // (fleet-manager.js is a large module to load)
});

describe("web.chat_archive.files_max_gb in fleet.yaml", () => {
  const v = (chat_archive: unknown) => validateFleetConfig({ instances: {}, web: { chat_archive } } as never);
  it("a number of GB 0–100000 (decimals allowed); anything else an error; a known key (no unknown-key warning)", () => {
    for (const ok of [0, 0.5, 5, 100_000]) expect(v({ files_max_gb: ok }).errors.filter((e: { path: string }) => e.path.startsWith("web.chat_archive")), String(ok)).toEqual([]);
    for (const bad of [-1, 100_001, "5", Number.NaN]) expect(v({ files_max_gb: bad }).errors.map((e: { path: string }) => e.path), String(bad)).toContain("web.chat_archive.files_max_gb");
    expect(JSON.stringify(v({ files_max_gb: 5, retention_days: 0 }).warnings ?? [])).not.toContain("files_max_gb");
  });
});

describe("the page: an archived message's file past the limit reads 'no longer kept' (a window message's: 'unavailable', as before)", () => {
  let dom: MiniPage | null = null;
  afterEach(() => { dom?.restore(); dom = null; });
  it.each([["en", "no longer kept", "unavailable"], ["zh-TW", "已不再保留", "無法取得"]])("%s", async (lang, notKept, unavailable) => {
    dom = installDom({});
    const { t, setLang } = await import("/assets/app-i18n.js") as any;
    await import("/ui/js/chat-strings.js"); setLang(lang, { store: false });
    const { createThread } = await import("/ui/js/chat-thread.js") as any;
    const doc = dom.document as any, list = doc.createElement("div"), scroller = doc.createElement("div"); scroller.append(list); doc.body.append(scroller);
    const th = createThread(list, scroller, { t, tf: t, isUser: () => false, serverNow: () => 0, onJump() {}, onEmpty() {}, onTop() {}, onBottom() {}, detached: () => false });
    const gone = { gone: true, kind: "document", name: "report.pdf", size: 2048, mime: "application/pdf" };
    th.render([
      { boot: "b", id: 1, instance: "w", role: "agent", sender: "w", text: "old", ts: new Date(NOV).toISOString(), archived: true, attachments: [gone] },
      { boot: "b", id: 2, instance: "w", role: "agent", sender: "w", text: "new", ts: new Date(NOV + 1).toISOString(), attachments: [gone] },
    ]);
    const labels = [...list.querySelectorAll(".att-gone .att-size")].map((e: any) => e.textContent);
    expect(labels).toEqual([notKept, unavailable]);
  });
});

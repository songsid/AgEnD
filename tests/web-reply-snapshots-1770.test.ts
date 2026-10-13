/**
 * #1770 part 2 (design: issue comment 6139874587): a file an agent attaches to its reply is copied, when the reply is
 * routed, into the instance's own `workspaces/<instance>/web-files/<id><ext>`; the web chat serves and keeps the copy.
 * So it is still there after the agent rewrites or deletes its file, after /tmp is cleaned, and after a fleet restart
 * (restoreServed accepts exactly the inbox and web-files). Refused: a symlink, not a regular file, over 50 MB, a state
 * file (also through a parent that leads into the state dir). Bounded: a snapshot leaves with its message, an
 * instance's directory is held to a byte cap (oldest first), and a fleet start removes what no restored message holds.
 * Snapshots are outside the served-id cap. Telegram and Discord keep the agent's own path.
 *
 * Real files on scratch directories; a real FleetManager on a scratch AGEND_HOME (never the real one), no daemon, no
 * CLI, no tmux (bd0c88aa).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoom, REPLY_FILES_MAX_BYTES, snapshotExt, snapshotReplyFile, sweepReplySnapshots, webFilesDir } from "../src/web-reply-files.js";
import { MAX_SERVED_BYTES, WebFileLedger } from "../src/web-upload.js";
import { WebChatHistory } from "../src/web-chat-history.js";

// The path checked by lstat can be swapped for a symlink before it is opened: the race is staged by answering one lstat
// as the regular file it was a moment before.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, lstat: vi.fn(real.lstat), realpath: vi.fn(real.realpath), open: vi.fn(real.open) };
});
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const dirs: string[] = [];
const scratch = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `agend-test-1770-${tag}-`)); dirs.push(d); return d; };
let home: string, outside: string;
beforeEach(() => { home = scratch("home"); outside = scratch("tmp"); vi.stubEnv("AGEND_HOME", home); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ID = (c: string) => c.repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const put = (p: string, data: string | Buffer) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); return p; };
const dirOf = (instance = "w") => webFilesDir(home, instance)!;
const snap = (src: string, id = ID("a"), opts: Record<string, number> = {}) => snapshotReplyFile(src, dirOf(), id, { stateDir: home, ...opts });

describe("#1770: snapshotReplyFile copies the agent's file into the instance's web-files", () => {
  it("the bytes, as <id><ext>, private (0700 dir, 0600 file), no temp file left", async () => {
    const src = put(join(outside, "Chart.PNG"), PNG);
    const r = await snap(src);
    expect(r).toEqual({ ok: true, path: join(home, "workspaces", "w", "web-files", `${ID("a")}.png`), size: PNG.length, evicted: [] });
    expect(readFileSync((r as { path: string }).path)).toEqual(PNG);
    expect([statSync(dirOf()).mode & 0o777, statSync((r as { path: string }).path).mode & 0o777]).toEqual([0o700, 0o600]);
    expect(readdirSync(dirOf())).toEqual([`${ID("a")}.png`]);
    expect([snapshotExt("/x/report.HTML"), snapshotExt("/x/noext"), snapshotExt("/x/a.we!rd"), snapshotExt("/x/a.abcdefghijk")]).toEqual([".html", "", "", ""]);
    expect([webFilesDir(home, "../evil"), webFilesDir(home, "a/b"), webFilesDir(home, "")]).toEqual([null, null, null]);
  });

  it("refused, and nothing copied: a symlink, a directory, a missing file, over 50 MB", async () => {
    const real = put(join(outside, "real.png"), PNG);
    symlinkSync(real, join(outside, "link.png"));
    mkdirSync(join(outside, "folder"));
    const big = put(join(outside, "big.bin"), "");
    truncateSync(big, MAX_SERVED_BYTES + 1);                                  // sparse: no 50 MB written
    const atLimit = put(join(outside, "limit.bin"), "");
    truncateSync(atLimit, MAX_SERVED_BYTES);
    const reasons = [];
    for (const p of [join(outside, "link.png"), join(outside, "folder"), join(outside, "missing.png"), big]) {
      const r = await snap(p);
      expect(r.ok, p).toBe(false);
      reasons.push((r as { refused: boolean; reason: string }).refused && (r as { reason: string }).reason);
    }
    expect(reasons).toEqual(["a symlink", "not a regular file", "cannot be read", "over the size limit"]);
    expect(existsSync(dirOf()) ? readdirSync(dirOf()) : [], "nothing copied").toEqual([]);
    expect((await snap(atLimit, ID("b"))).ok, "exactly 50 MB is within the limit").toBe(true);
  });

  it("a path swapped for a symlink between the check and the open is not followed (O_NOFOLLOW)", async () => {
    const { lstat } = await import("node:fs/promises");
    const target = put(join(outside, "elsewhere.png"), PNG);
    const regular = await (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).lstat(target);
    symlinkSync(target, join(outside, "swapped.png"));
    vi.mocked(lstat).mockResolvedValueOnce(regular);                         // what the check saw: a regular file
    const r = await snap(join(outside, "swapped.png"));
    expect(r).toEqual({ ok: false, refused: true, reason: "cannot be read" });
    expect(existsSync(dirOf()) ? readdirSync(dirOf()) : []).toEqual([]);
  });

  it("the path naming another file by the time its real path is read is refused (device + inode of the open file)", async () => {
    const { realpath } = await import("node:fs/promises");
    const src = put(join(outside, "a.png"), PNG);
    const other = put(join(outside, "b.png"), PNG);
    vi.mocked(realpath).mockResolvedValueOnce(other);
    expect(await snap(src)).toEqual({ ok: false, refused: true, reason: "replaced while it was opened" });
  });

  it("a file rewritten while it is copied is not kept (a torn copy): no snapshot, no temp file — the caller falls back", async () => {
    const fsp = await import("node:fs/promises");
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const src = put(join(outside, "a.png"), PNG);
    vi.mocked(fsp.open).mockImplementationOnce((async (...a: Parameters<typeof real.open>) => {
      const fh = await real.open(...a);
      const stat = fh.stat.bind(fh);
      let n = 0;
      // The second look (after the copy) sees the file changed since the first.
      (fh as any).stat = async (...x: any[]) => { const st: any = await stat(...x); if (++n === 2) st.mtimeMs += 1000; return st; };
      return fh;
    }) as typeof real.open);
    expect(await snap(src)).toEqual({ ok: false, refused: false, reason: "changed while it was copied", evicted: [] });
    expect(readdirSync(dirOf())).toEqual([]);
  });

  it("a state file is refused — directly, or through a parent directory that leads into the state dir; the inbox is not", async () => {
    const secret = put(join(home, "fleet.yaml"), "token: x");
    put(join(home, "workspaces", "w", "notes.txt"), "workspace");
    const inboxFile = put(join(home, "workspaces", "w", "inbox", "photo.png"), PNG);
    symlinkSync(home, join(outside, "via"));                                  // a parent swapped for a link into the state dir
    const refusedHow = async (p: string) => { const r = await snap(p); return r.ok ? "ok" : (r as { reason: string }).reason; };
    expect(await refusedHow(secret)).toBe("inside the AgEnD state directory");
    expect(await refusedHow(join(outside, "via", "fleet.yaml"))).toBe("inside the AgEnD state directory");
    expect(await refusedHow(join(outside, "via", "workspaces", "w", "notes.txt"))).toBe("inside the AgEnD state directory");
    expect(await refusedHow(inboxFile), "the reply tool allows inbox/ files, and so does the copy").toBe("ok");
  });

  it("a snapshot directory that is a link elsewhere is not written through (the caller falls back)", async () => {
    const elsewhere = scratch("elsewhere");
    mkdirSync(join(home, "workspaces", "w"), { recursive: true });
    symlinkSync(elsewhere, dirOf());
    const r = await snap(put(join(outside, "a.png"), PNG));
    expect(r).toMatchObject({ ok: false, refused: false });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("#1770: the per-instance byte cap and the startup sweep", () => {
  const seed = (name: string, bytes: number, ageS: number) => {
    const p = put(join(dirOf(), name), Buffer.alloc(bytes, 1));
    const t = Date.now() / 1000 - ageS; utimesSync(p, t, t);
    return p;
  };

  it("makeRoom removes the oldest snapshots until the new file fits; nothing that is not ours is counted or touched", () => {
    seed(`${ID("1")}.png`, 40, 300); seed(`${ID("2")}.html`, 40, 200); seed(`${ID("3")}`, 40, 100);
    seed("notes.txt", 500, 400);                                               // not ours: never counted, never removed
    expect(makeRoom(dirOf(), 10, 130), "120 + 10 fits in 130").toEqual([]);
    expect(makeRoom(dirOf(), 50, 130), "the oldest goes").toEqual([ID("1")]);
    expect(makeRoom(dirOf(), 130, 130), "all of it").toEqual([ID("2"), ID("3")]);
    expect(readdirSync(dirOf())).toEqual(["notes.txt"]);
    expect(REPLY_FILES_MAX_BYTES, "one maximal reply (20 × 50 MB) fits whole").toBeGreaterThanOrEqual(20 * MAX_SERVED_BYTES);
  });

  it("snapshotReplyFile makes room first and says which ids it removed", async () => {
    seed(`${ID("1")}.png`, 8, 300); seed(`${ID("2")}.png`, 8, 200);
    const r = await snap(put(join(outside, "new.png"), PNG), ID("9"), { maxDirBytes: 15 });
    expect(r).toMatchObject({ ok: true, evicted: [ID("1"), ID("2")] });
    expect(readdirSync(dirOf())).toEqual([`${ID("9")}.png`]);
  });

  it("the sweep removes snapshots no message holds and stopped copies; keeps held ones, other names, links and directories", () => {
    seed(`${ID("1")}.png`, 4, 10); seed(`${ID("2")}.png`, 4, 10); seed(`.tmp-${ID("3")}`, 4, 10); seed("keep.txt", 4, 10);
    const target = put(join(outside, "t.png"), "x");
    symlinkSync(target, join(dirOf(), `${ID("4")}.png`));
    mkdirSync(join(dirOf(), ID("5")));
    expect(sweepReplySnapshots(dirOf(), new Set([ID("2")]))).toBe(2);
    expect(readdirSync(dirOf()).sort()).toEqual([`${ID("2")}.png`, `${ID("4")}.png`, ID("5"), "keep.txt"].sort());
    expect(existsSync(target), "a link is never followed").toBe(true);
  });

  it("a snapshot directory that is a link elsewhere is never swept or trimmed", () => {
    const elsewhere = scratch("elsewhere");
    put(join(elsewhere, `${ID("1")}.png`), "x");
    mkdirSync(join(home, "workspaces", "w"), { recursive: true });
    symlinkSync(elsewhere, dirOf());
    expect([sweepReplySnapshots(dirOf(), new Set()), makeRoom(dirOf(), 100, 1)]).toEqual([0, []]);
    expect(readdirSync(elsewhere)).toEqual([`${ID("1")}.png`]);
  });
});

describe("#1770: the ledger keeps snapshots as long as their message", () => {
  it("snapshots are outside the served-id cap; files registered by path keep it", () => {
    const ledger = new WebFileLedger({ maxServed: 2 });
    const snaps = ["1", "2", "3"].map(c => ledger.registerServed({ id: ID(c), path: put(join(dirOf(), `${ID(c)}.png`), PNG), instance: "w", snapshot: true })!);
    const plain = ["4", "5", "6"].map(c => ledger.registerServed({ id: ID(c), path: put(join(outside, `${c}.png`), PNG), instance: "w" })!);
    expect(snaps.map(f => ledger.read(f.id) !== null)).toEqual([true, true, true]);
    expect(plain.map(f => ledger.read(f.id) !== null), "the oldest by-path file goes").toEqual([false, true, true]);
    expect([...ledger.heldSnapshots("w")].sort()).toEqual([ID("1"), ID("2"), ID("3")]);
    expect(ledger.heldSnapshots("other").size).toBe(0);
  });

  it("dropServed removes a snapshot from disk — only the file registered — and never a file registered by path", () => {
    const ledger = new WebFileLedger();
    const s = ledger.registerServed({ id: ID("1"), path: put(join(dirOf(), `${ID("1")}.png`), PNG), instance: "w", snapshot: true })!;
    const swapped = ledger.registerServed({ id: ID("2"), path: put(join(dirOf(), `${ID("2")}.png`), PNG), instance: "w", snapshot: true })!;
    const agentOwn = put(join(outside, "agent.png"), PNG);
    const p = ledger.registerServed({ id: ID("3"), path: agentOwn, instance: "w" })!;
    // Moved away (still alive, so its inode cannot be reused) and another file put in its place.
    renameSync(swapped.realPath, join(outside, "moved.png")); put(swapped.realPath, "another file in its place");
    ledger.dropServed([s.id, swapped.id, p.id, ID("9")]);
    expect([existsSync(s.realPath), existsSync(swapped.realPath), existsSync(agentOwn)]).toEqual([false, true, true]);
    expect([s.id, swapped.id, p.id].map(id => ledger.read(id))).toEqual([null, null, null]);
  });

  it("restoreServed: a web-files path is restored as a snapshot; another directory, or a web-files that links elsewhere, is not", () => {
    const ledger = new WebFileLedger();
    const inbox = join(home, "workspaces", "w", "inbox");
    const path = put(join(dirOf(), `${ID("1")}.png`), PNG);
    const f = ledger.restoreServed({ id: ID("1"), path, name: "chart.png", kind: "photo" }, "w", inbox, dirOf())!;
    expect([f.name, f.mime, f.snapshot, ledger.read(ID("1"))!.bytes]).toEqual(["chart.png", "image/png", true, PNG]);
    expect(ledger.restoreServed({ id: ID("1"), path }, "w", inbox), "without the web-files directory: as before #1770").toBeNull();
    expect(ledger.restoreServed({ id: ID("2"), path: put(join(outside, "x.png"), PNG) }, "w", inbox, dirOf())).toBeNull();
    // The other instance's web-files is not this one's.
    const theirs = put(join(dirOf("v"), `${ID("3")}.png`), PNG);
    expect(ledger.restoreServed({ id: ID("3"), path: theirs }, "w", inbox, dirOf())).toBeNull();
    // An inbox file is still restored, and not as a snapshot.
    const up = ledger.restoreServed({ id: ID("4"), path: put(join(inbox, "web-1-ab.png"), PNG) }, "w", inbox, dirOf())!;
    expect(up.snapshot).toBeUndefined();
    // A web-files that is a link elsewhere: nothing in it is restored.
    const elsewhere = scratch("elsewhere");
    const lent = put(join(elsewhere, `${ID("5")}.png`), PNG);
    mkdirSync(join(home, "workspaces", "u"), { recursive: true });
    symlinkSync(elsewhere, dirOf("u"));
    expect(ledger.restoreServed({ id: ID("5"), path: join(dirOf("u"), `${ID("5")}.png`) }, "u", join(home, "workspaces", "u", "inbox"), dirOf("u"))).toBeNull();
    expect(ledger.restoreServed({ id: ID("5"), path: lent }, "u", join(home, "workspaces", "u", "inbox"), dirOf("u"))).toBeNull();
  });

  it("a message that leaves the history takes its snapshot with it", () => {
    const ledger = new WebFileLedger();
    const hist = new WebChatHistory({ boot: "aa", perInstance: 1 });
    hist.setFiles({ storablePath: (id) => ledger.storablePath(id), restore: () => null, drop: (ids) => ledger.dropServed(ids) });
    const f = ledger.registerServed({ id: ID("1"), path: put(join(dirOf(), `${ID("1")}.png`), PNG), instance: "w", snapshot: true })!;
    hist.record({ instance: "w", sender: "w", role: "agent", text: "one", ts: "2026-10-13T01:00:00Z", attachments: [{ id: f.id, kind: "photo", name: "c.png", size: PNG.length, mime: "image/png" }] });
    expect(existsSync(f.realPath)).toBe(true);
    hist.record({ instance: "w", sender: "w", role: "agent", text: "two", ts: "2026-10-13T01:00:01Z" });
    expect(existsSync(f.realPath), "evicted with its message").toBe(false);
  });
});

describe("#1770: the fleet — a reply's files are served from their snapshot, across edits and restarts", () => {
  const fleet = { defaults: {}, instances: { w: { working_directory: "/w/w" } } };
  async function start() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(home) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.fleetConfig = fleet;
    fm.restoreWebChat(fleet);
    fm.getInstanceIdle = () => true; fm.clearCancelButton = () => {}; fm.reactDone = () => {};
    const events: any[] = [];
    const emit = fm.emitSseEvent.bind(fm);
    fm.emitSseEvent = (event: string, data: unknown) => { events.push({ event, data }); emit(event, data); };
    return { fm, events, messages: () => events.filter(e => e.event === "message").map(e => e.data) };
  }

  it("served from the copy: the agent rewrites, then deletes, its file — the chat still has the original bytes", async () => {
    const { fm, messages } = await start();
    const chart = put(join(outside, "chart.png"), PNG);
    const page = put(join(outside, "report.html"), "<p>v1</p>");
    const args = { text: "here", files: [chart, page] };
    await fm.afterReplyRouted("w", args);
    const [msg] = messages();
    expect(msg.attachments.map((a: any) => [a.name, a.kind, a.mime, a.size])).toEqual([["chart.png", "photo", "image/png", PNG.length], ["report.html", "document", "application/octet-stream", 9]]);
    expect(JSON.stringify(msg)).not.toContain(outside);
    expect(args.files, "the platforms' path is the agent's own, untouched").toEqual([chart, page]);
    writeFileSync(page, "<p>v2 — rewritten in place, longer</p>");
    rmSync(chart);
    expect(fm.webFiles.read(msg.attachments[0].id).bytes).toEqual(PNG);
    expect(fm.webFiles.read(msg.attachments[1].id).bytes.toString()).toBe("<p>v1</p>");
    expect(readdirSync(dirOf()).sort()).toEqual(msg.attachments.map((a: any) => a.id + (a.name.endsWith(".png") ? ".png" : ".html")).sort());
    await fm.webChatStore?.flush();
  });

  it("after a restart: restored from the snapshot (the /tmp original is gone); a refused file was never shown", async () => {
    const one = await start();
    const chart = put(join(outside, "chart.png"), PNG);
    symlinkSync(chart, join(outside, "link.png"));
    await one.fm.afterReplyRouted("w", { text: "here", files: [chart, join(outside, "link.png")] });
    const [msg] = one.messages();
    expect(msg.attachments.map((a: any) => a.name), "the symlink is refused: not shown").toEqual(["chart.png"]);
    await one.fm.webChatStore?.flush();
    rmSync(outside, { recursive: true, force: true });                        // /tmp cleaned while the fleet was down
    const two = await start();
    const [restored] = two.fm.webChatHistory.list("w");
    expect(restored.attachments).toEqual([{ id: msg.attachments[0].id, kind: "photo", name: "chart.png", size: PNG.length, mime: "image/png" }]);
    expect(two.fm.webFiles.read(msg.attachments[0].id).bytes).toEqual(PNG);
    await two.fm.webChatStore?.flush();
  });

  it("a fleet start removes the snapshots no restored message holds, and a stopped copy's temp file", async () => {
    const one = await start();
    await one.fm.afterReplyRouted("w", { text: "keep", files: [put(join(outside, "a.png"), PNG)] });
    const kept = one.messages()[0].attachments[0].id;
    await one.fm.webChatStore?.flush();
    put(join(dirOf(), `${ID("e")}.png`), PNG);                                // its message is gone
    put(join(dirOf(), `.tmp-${ID("f")}`), "half");
    await start();
    expect(readdirSync(dirOf())).toEqual([`${kept}.png`]);
  });

  it("replies reach the chat in order: one without files waits for the one before it that is still copying", async () => {
    const { fm, messages } = await start();
    const first = fm.afterReplyRouted("w", { text: "first, with a file", files: [put(join(outside, "a.png"), PNG)] });
    const second = fm.afterReplyRouted("w", { text: "second, no files" });
    expect(messages(), "nothing shown before the copy").toEqual([]);
    await Promise.all([first, second]);
    expect(messages().map((m: any) => m.text)).toEqual(["first, with a file", "second, no files"]);
    // Nothing pending: a reply without files is shown at once, as before.
    fm.afterReplyRouted("w", { text: "third" });
    expect(messages().map((m: any) => m.text).at(-1)).toBe("third");
    expect(fm.webReplyOrder.size).toBe(0);
    await fm.webChatStore?.flush();
  });

  it("the byte cap: the oldest reply's snapshot is evicted from disk and from the ledger; its message no longer holds it", async () => {
    const { fm, messages } = await start();
    fm.webReplyMaxBytes = PNG.length + 4;                                     // room for one
    await fm.afterReplyRouted("w", { text: "one", files: [put(join(outside, "a.png"), PNG)] });
    await fm.afterReplyRouted("w", { text: "two", files: [put(join(outside, "b.png"), PNG)] });
    const [a, b] = messages().map((m: any) => m.attachments[0].id);
    expect(readdirSync(dirOf())).toEqual([`${b}.png`]);
    expect([...fm.webFiles.heldSnapshots("w")]).toEqual([b]);
    expect([fm.webFiles.read(a), fm.webFiles.read(b).bytes]).toEqual([null, PNG]);
    await fm.webChatStore?.flush();
  });

  it("a copy that fails for an I/O reason falls back to the agent's own path (as before #1770)", async () => {
    const { fm, messages } = await start();
    mkdirSync(join(home, "workspaces", "w"), { recursive: true });
    writeFileSync(dirOf(), "a file where the directory should be");          // mkdir fails: EEXIST / ENOTDIR
    const chart = put(join(outside, "chart.png"), PNG);
    await fm.afterReplyRouted("w", { text: "here", files: [chart] });
    const [msg] = messages();
    expect(msg.attachments.map((a: any) => a.name)).toEqual(["chart.png"]);
    expect(fm.webFiles.storablePath(msg.attachments[0].id)).toBe(chart);
    await fm.webChatStore?.flush();
  });

  it("unwritable snapshot directory (EACCES) falls back too, and nothing is half-written", async () => {
    if (process.getuid?.() === 0) return;                                     // root ignores the mode
    const { fm, messages } = await start();
    mkdirSync(dirOf(), { recursive: true }); chmodSync(dirOf(), 0o500);
    try {
      await fm.afterReplyRouted("w", { text: "here", files: [put(join(outside, "chart.png"), PNG)] });
      expect(messages()[0].attachments.map((a: any) => a.name)).toEqual(["chart.png"]);
      expect(readdirSync(dirOf())).toEqual([]);
    } finally { chmodSync(dirOf(), 0o700); }
    await fm.webChatStore?.flush();
    expect(lstatSync(dirOf()).isDirectory()).toBe(true);
  });
});

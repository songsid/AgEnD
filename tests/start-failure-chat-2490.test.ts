/**
 * #2490: #2481's "installed, but the fleet fails to start" notice in chat — General's topic, else the admin's DM — sent
 * by `fleet start` itself (start-attempt.ts) on the third attempt of a version within the window, once per version.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_FILE, STARTED_FILE, chatClaimFile, chatNoticeDue, claimChatNotice, notifyChatOnce, notifyOnce, readAttempts, recordStartAttempt,
} from "../src/start-failure.js";
import { recordFleetStartAttempt } from "../src/start-attempt.js";
import { fleetLockHeldByAnother } from "../src/fleet-lock.js";
import { chatNoticeTarget, chatNoticeText, postChatNotice, type ChatTarget } from "../src/start-failure-chat.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-2490-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); });

const NOW = Date.parse("2026-10-23T05:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const rec = (attempts: string[], extra: Record<string, unknown> = {}) => ({ version: "2.3.1", attempts, ...extra });

describe("#2490 when the chat notice is due", () => {
  it("the third attempt of a version within 10 minutes, none completed — not the first or second", () => {
    expect(chatNoticeDue(rec([ago(20)]), null, NOW)).toBe(false);
    expect(chatNoticeDue(rec([ago(20), ago(10)]), null, NOW)).toBe(false);
    expect(chatNoticeDue(rec([ago(20), ago(10), ago(0)]), null, NOW)).toBe(true);
  });
  it("never for a version that started here, or for attempts outside the window", () => {
    const three = [ago(20), ago(10), ago(0)];
    expect(chatNoticeDue(rec(three), { version: "2.3.1", at: ago(5), pid: 1, history: ["2.3.1"] }, NOW)).toBe(false);
    expect(chatNoticeDue(rec([ago(1300), ago(700), ago(0)]), null, NOW)).toBe(false);    // two of them older than 10 min
    expect(chatNoticeDue(rec(three), { version: "2.2.6", at: ago(9000), pid: 1, history: ["2.2.6"] }, NOW)).toBe(true);
  });
  it("systemd's 4 quick starts (StartLimitBurst) and launchd's 10 s retries both reach a third attempt", () => {
    expect(chatNoticeDue(rec([ago(0.3), ago(0.2), ago(0.1)]), null, NOW)).toBe(true);
    expect(chatNoticeDue(rec([ago(20), ago(10), ago(0)]), null, NOW)).toBe(true);
  });
});

describe("#2490 once per version, from start-attempt", () => {
  const seed = (home: string, attempts: string[], extra: Record<string, unknown> = {}) =>
    writeFileSync(join(home, ATTEMPTS_FILE), JSON.stringify(rec(attempts, extra)));
  const free = { lockHeld: () => false, notify: () => false, restore: () => ({ kind: "not-due" as const }) };

  it("runs the notifier once, claimed first; every later attempt of that crash loop does nothing", () => {
    const home = scratch();
    const run = vi.fn();
    for (let i = 0; i < 6; i++) {
      recordFleetStartAttempt(home, "2.3.1", NOW - (5 - i) * 10_000, { ...free, notifyChat: (h, v, n) => notifyChatOnce(h, v, n, run) });
    }
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = run.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toMatch(/start-failure-chat\.js$/);
    expect(args[1]).toBe(home);
    expect(opts).toEqual({ timeout: 10_000 });
    expect(existsSync(chatClaimFile(home, "2.3.1")!)).toBe(true);
  });

  it("a newer version gets its own notice (and the older claim goes)", () => {
    const home = scratch();
    const run = vi.fn();
    seed(home, [ago(20), ago(10), ago(0)]);
    expect(notifyChatOnce(home, "2.3.1", NOW, run)).toBe(true);
    for (let i = 0; i < 3; i++) { recordStartAttempt(home, "2.3.2", NOW + i); notifyChatOnce(home, "2.3.2", NOW + i, run); }
    expect(run).toHaveBeenCalledTimes(2);
    expect(existsSync(chatClaimFile(home, "2.3.1")!)).toBe(false);
  });

  it("Prism r1: a stale writer of the attempts record (the macOS notification's) cannot undo the claim", () => {
    const home = scratch();
    seed(home, [ago(20), ago(10), ago(0)]);
    const captured = readAttempts(home)!;                       // what notifyOnce was handed, before the chat claim
    const run = vi.fn();
    expect(notifyChatOnce(home, "2.3.1", NOW, run)).toBe(true);
    expect(notifyOnce(home, captured, "darwin", () => ({}))).toBe(true);   // writes its stale copy of the record
    expect(readAttempts(home)).toMatchObject({ notified: true });
    recordStartAttempt(home, "2.3.1", NOW + 1);
    expect(notifyChatOnce(home, "2.3.1", NOW + 1, run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Prism r1: concurrent claimants in separate processes — exactly one wins", async () => {
    const home = scratch();
    const go = join(home, "go");
    // Each child loads the module, says "ready", then waits (sleeping, not spinning) for the go file and claims at once.
    const script = `import { existsSync } from "node:fs"; import { claimChatNotice } from ${JSON.stringify(join(process.cwd(), "src", "start-failure.ts"))};
      process.stdout.write("ready;"); const nap = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(process.argv[2])) Atomics.wait(nap, 0, 0, 2);
      process.stdout.write(claimChatNotice(process.argv[1], "2.3.1") ? "won" : "lost");`;
    const kids = Array.from({ length: 4 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home, go], { stdio: ["ignore", "pipe", "inherit"] }));
    const outs = kids.map(() => "");
    const ready = kids.map((k, i) => new Promise<void>(resolve => k.stdout!.on("data", d => { outs[i] += d; if (outs[i].includes("ready;")) resolve(); })));
    const closed = kids.map(k => new Promise<void>(resolve => k.on("close", () => resolve())));
    await Promise.all(ready);
    writeFileSync(go, "");
    await Promise.all(closed);
    expect(outs.map(o => o.replace("ready;", "")).sort()).toEqual(["lost", "lost", "lost", "won"]);
  }, 30_000);

  it("Prism r1: a `fleet start` refused beside a live fleet is not recorded — the next genuine start is attempt one, no notice", () => {
    const home = scratch();
    const run = vi.fn();
    const chat = (h: string, v: string, n: number) => notifyChatOnce(h, v, n, run);
    expect(recordFleetStartAttempt(home, "2.3.1", NOW - 20_000, { lockHeld: () => true, notify: () => false, notifyChat: chat })).toBeNull();
    expect(recordFleetStartAttempt(home, "2.3.1", NOW - 10_000, { lockHeld: () => true, notify: () => false, notifyChat: chat })).toBeNull();
    expect(readAttempts(home)).toBeNull();
    expect(recordFleetStartAttempt(home, "2.3.1", NOW, { ...free, notifyChat: chat })).toEqual({ kind: "not-due" });
    expect(readAttempts(home)!.attempts).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    // control: two more genuine failed starts → the third sends, once
    recordFleetStartAttempt(home, "2.3.1", NOW + 10_000, { ...free, notifyChat: chat });
    expect(run).not.toHaveBeenCalled();
    recordFleetStartAttempt(home, "2.3.1", NOW + 20_000, { ...free, notifyChat: chat });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("not when the version has started here", () => {
    const home = scratch();
    seed(home, [ago(20), ago(10), ago(0)]);
    writeFileSync(join(home, STARTED_FILE), JSON.stringify({ version: "2.3.1", at: ago(1), pid: 1, history: ["2.3.1"] }));
    expect(notifyChatOnce(home, "2.3.1", NOW, vi.fn())).toBe(false);
  });

  it("never throws, even when the notifier cannot run; the claim stands (no retry storm)", () => {
    const home = scratch();
    seed(home, [ago(20), ago(10), ago(0)]);
    expect(notifyChatOnce(home, "2.3.1", NOW, () => { throw new Error("spawn failed"); })).toBe(false);
    expect(claimChatNotice(home, "2.3.1")).toBe(false);
  });

  it("a version that cannot be a file name is never claimed", () => {
    expect(chatClaimFile("/h", "2.3.1-beta.2")).toBe("/h/fleet-start-chat-notified-2.3.1-beta.2");
    expect(chatClaimFile("/h", "../x")).toBeNull();
    expect(claimChatNotice(scratch(), "a/b")).toBe(false);
  });
});

describe("#2490 r1: whether the lock would refuse this `fleet start` (fleetLockHeldByAnother, as acquireFleetLock reads it)", () => {
  const lock = (role?: string, pid = 4242) => { const h = scratch(); writeFileSync(join(h, "fleet.lock"), JSON.stringify({ pid, nonce: "n", createdAt: "x", ...(role ? { role } : {}) })); return h; };
  const alive = () => true;
  it.each([
    ["a live fleet", undefined, "node /x/dist/cli.js fleet start", true],
    ["a live owner whose command line cannot be read", undefined, "", true],
    ["a reused pid (another program)", undefined, "/usr/bin/vim notes", false],
    ["a live setup host", "setup-host", "node /x/dist/cli.js setup --host", true],
  ] as const)("%s → %s", (_n, role, cmd, held) => {
    expect(fleetLockHeldByAnother(lock(role), { isProcessAlive: alive, readCommandLine: () => cmd, pid: 1 })).toBe(held);
  });
  it("no lock, an unreadable record, a dead owner, or this very process: not held", () => {
    expect(fleetLockHeldByAnother(scratch(), { isProcessAlive: alive, readCommandLine: () => "agend fleet start" })).toBe(false);
    const bad = scratch(); writeFileSync(join(bad, "fleet.lock"), "{not json");
    expect(fleetLockHeldByAnother(bad, { isProcessAlive: alive, readCommandLine: () => "agend fleet start" })).toBe(false);
    expect(fleetLockHeldByAnother(lock(), { isProcessAlive: () => false, readCommandLine: () => "agend fleet start" })).toBe(false);
    expect(fleetLockHeldByAnother(lock(undefined, 777), { pid: 777, isProcessAlive: alive, readCommandLine: () => "agend fleet start" })).toBe(false);
  });
});

describe("#2490 where the notice goes", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const tg = { type: "telegram", bot_token_env: "TG", group_id: -100123, access: { allowed_users: [111] } };
  it("Telegram: General's topic in the fleet group; General's own forum topic (1) takes no thread", () => {
    expect(chatNoticeTarget({ channel: tg, instances: { general: { general_topic: true, topic_id: 7 } } }, env({ TG: "123:abc" })))
      .toEqual({ platform: "telegram", token: "123:abc", apiRoot: "https://api.telegram.org", chatId: "-100123", threadId: 7 });
    expect(chatNoticeTarget({ channel: tg, instances: { general: { general_topic: true, topic_id: 1 } } }, env({ TG: "123:abc" })))
      .toEqual({ platform: "telegram", token: "123:abc", apiRoot: "https://api.telegram.org", chatId: "-100123" });
  });
  it("Telegram without a General: the first admin's DM; the API root honours telegram_api_root (loopback mock)", () => {
    expect(chatNoticeTarget({ channel: { ...tg, telegram_api_root: "http://127.0.0.1:18443/" }, instances: {} }, env({ TG: "t" })))
      .toEqual({ platform: "telegram", token: "t", apiRoot: "http://127.0.0.1:18443", chatId: "111" });
  });
  it("a telegram_api_root off the allowlist is refused (the token never goes there)", () => {
    expect(() => chatNoticeTarget({ channel: { ...tg, telegram_api_root: "https://evil.example" }, instances: {} }, env({ TG: "t" }))).toThrow(/allowlist/);
  });
  it("Discord: General's channel, else a DM to the first admin; the General on the primary channel wins", () => {
    const dc = { id: "main", type: "discord", bot_token_env: "DC", group_id: "g", access: { allowed_users: ["999"] } };
    const other = { id: "side", type: "discord", bot_token_env: "DC2", access: { allowed_users: [] } };
    expect(chatNoticeTarget({ channels: [dc, other], instances: {
      a: { general_topic: true, topic_id: "555", channel_id: "side" }, b: { general_topic: true, topic_id: "444", channel_id: "main" },
    } }, env({ DC: "dtoken", DC2: "other" }))).toEqual({ platform: "discord", token: "dtoken", channelId: "444" });
    expect(chatNoticeTarget({ channels: [dc], instances: {} }, env({ DC: "dtoken" }))).toEqual({ platform: "discord-dm", token: "dtoken", userId: "999" });
  });
  it("nowhere: no channel, no token, no General and no admin, an unknown type", () => {
    expect(chatNoticeTarget(null, env({}))).toBeNull();
    expect(chatNoticeTarget({ channel: tg, instances: { g: { general_topic: true, topic_id: 7 } } }, env({}))).toBeNull();
    expect(chatNoticeTarget({ channel: { ...tg, access: { allowed_users: [] } }, instances: {} }, env({ TG: "t" }))).toBeNull();
    expect(chatNoticeTarget({ channel: { ...tg, type: "slack" }, instances: { g: { general_topic: true, topic_id: 7 } } }, env({ TG: "t" }))).toBeNull();
  });
});

describe("#2490 posting", () => {
  const ok = (body: unknown = {}) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  it("Telegram: sendMessage with the thread; the outcome never carries the token", async () => {
    const fetch = vi.fn((_url: string, _init: unknown) => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    const target: ChatTarget = { platform: "telegram", token: "123:SECRET", apiRoot: "http://127.0.0.1:18443", chatId: "-100", threadId: 7 };
    const outcome = await postChatNotice(target, "hello", fetch);
    expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:18443/bot123:SECRET/sendMessage");
    expect(JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body)).toEqual({ chat_id: "-100", text: "hello", message_thread_id: 7 });
    expect(outcome).toBe("not sent (telegram: HTTP 403)");
    expect(outcome).not.toContain("SECRET");
  });
  it("Discord: a channel message with no mentions; a DM opens the channel first", async () => {
    const fetch = vi.fn((url: string, _init: unknown) => url.endsWith("/users/@me/channels") ? ok({ id: "dm1" }) : ok());
    expect(await postChatNotice({ platform: "discord-dm", token: "D", userId: "999" }, "x".repeat(2100), fetch)).toBe("sent (discord-dm)");
    expect(fetch.mock.calls.map(c => c[0])).toEqual(["https://discord.com/api/v10/users/@me/channels", "https://discord.com/api/v10/channels/dm1/messages"]);
    const init = fetch.mock.calls[1]![1] as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe("Bot D");
    const body = JSON.parse(init.body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toHaveLength(2000);
  });
  it("a network failure or timeout is a short outcome, never a throw", async () => {
    const down = () => Promise.reject(Object.assign(new Error("request to http://127.0.0.1/bot123:SECRET/sendMessage failed"), { name: "TypeError" }));
    const slow = () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const t: ChatTarget = { platform: "telegram", token: "123:SECRET", apiRoot: "https://api.telegram.org", chatId: "1" };
    expect(await postChatNotice(t, "x", down)).toBe("not sent (telegram: network error)");
    expect(await postChatNotice(t, "x", slow)).toBe("not sent (telegram: timed out)");
  });
});

describe("#2490 the words", () => {
  it("#2481's lines: the version, the attempts, the version to go back to and where the error is — in the fleet's language", () => {
    const home = scratch();
    const record = rec([ago(20), ago(10), ago(0)]);
    const text = chatNoticeText(home, record, { version: "2.2.6", at: ago(9000), pid: 1, history: ["2.2.6"] }, NOW, null);
    expect(text.split("\n")[0]).toBe("⚠ AgEnD v2.3.1 is installed, but the fleet fails to start (3 start attempts in the last 10 minutes, none completed).");
    expect(text).toContain("npm install -g @songsid/agend@2.2.6 && agend restart");
    expect(text).toContain(join(home, "fleet.log"));
    setLocale("zh-TW");
    expect(chatNoticeText(home, record, null, NOW, null)).toContain("fleet 無法啟動");
  });
});

/**
 * The live "Working…" line is for EVERY backend, because it comes from the page's busy state, not from a transcript.
 * Through the real chain — the log service answers the chat's GET /ui/steps the way the fleet's source resolution (fleet-manager
 * logSource) sets it for each backend, the feed takes the answer, the page composes the thread — one case per backend:
 *
 *   claude-code   a transcript with only the prompt (the thought not written yet): the empty live group of the turn (no statusOnly)
 *   codex         `supported: false` from the SERVICE, which returns before it looks at the file (#3709 R6: no activity
 *                 projection until a real fixture): the status line only — the transcript is never stat'ed or read
 *   muse, opencode, kiro-cli, antigravity/grok (on this line, which has no parser for them)   no transcript format: status line only
 *
 * The line says how long (the working bar's clock, else the last prompt), and the counter-proofs: not busy → no line; the
 * agent's tool_progress off → no line (the owner turned the chat's activity off for it); the first answer not in yet → none.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";
import { LogService, type LogSource } from "../src/log-service.js";
import type { ToolProgressLevel } from "../src/tool-progress.js";

type Mod = any;
let act: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  act = await import("/ui/js/chat-activity.js");
  await import("/ui/js/chat-strings.js");
  base.restore();
});
let pg: AppPage | null = null;
const dirs: string[] = [];
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.now();
const rows = [{ boot: "b", id: 1, role: "user", sender: "u", text: "do it", anchor: "w-u1", ts: new Date(NOW - 20_000).toISOString() }];
const promptOnly = JSON.stringify({ type: "user", promptId: "p1", timestamp: new Date(NOW - 20_000).toISOString(), message: { role: "user", content: "(message_id: w-u1 | verification_id: v)\ndo it" } }) + "\n";

/** The page's feed for instance `w` over a real LogService: what the chat asks, answered as the service answers it. */
async function feedFor(src: LogSource, level: ToolProgressLevel = "standard") {
  const svc = new LogService({ enabled: () => false, toolProgress: () => level, thinking: () => true, known: () => true, source: () => src, events: () => [], emit() {} });
  const fetcher = async (u: string) => {
    const q = new URL(u, "http://x").searchParams;
    const a = await svc.steps("w", { chat: true, ...(q.get("watch") === "1" ? { watch: true } : {}) } as never);
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(a)) };
  };
  pg = page(); (pg.document as any).body.dataset.chatActivity = "1";
  const feed = act.observeActivity("w", { fetcher, changed() {}, streamOn: () => () => {}, setTimer: () => 0, clearTimer() {} });
  feed.start(); await settle();
  // The service reads the transcript file for real: wait for the first answer instead of a fixed number of ticks (a loaded CI runner is slower than a laptop).
  for (let i = 0; i < 500; i++) { const info = act.activityInfo("w"); if (info && (info.supported !== null || info.level === "off")) break; await new Promise((r) => setTimeout(r, 10)); }
  await settle();
  return feed;
}
const shape = (r: Mod[]) => r.map((x: any) => (x.role === "activity" ? `act:${x.group.level}${x.group.statusOnly ? ":status" : ""}:${x.group.items.length}` : x.role)).join(" ");
const compose = (name: string, busy: boolean, since?: number) => act.composeActivity(name, rows, NOW, { busy, ...(since !== undefined ? { since } : {}) });

describe("claude-code: the transcript has the prompt and no thought yet", () => {
  it("busy: the turn's empty live group (not status-only); not busy: nothing", async () => {
    const d = mkdtempSync(join(tmpdir(), "agend-live-")); dirs.push(d);
    const f = join(d, "t.jsonl"); writeFileSync(f, promptOnly);
    await feedFor({ backend: "claude-code", path: f, format: "claude" });
    expect(shape(compose("w", true))).toBe("user act:live:0");
    expect(shape(compose("w", false))).toBe("user");
  });
});

describe("codex: R6 holds — the status line, and the transcript is never read", () => {
  it("the service answers unsupported without looking at the file; the line is there while busy", async () => {
    const d = mkdtempSync(join(tmpdir(), "agend-live-")); dirs.push(d);
    const f = join(d, "rollout.jsonl"); writeFileSync(f, promptOnly);
    const before = statSync(f).atimeMs;
    const feed = await feedFor({ backend: "codex", path: f, format: "codex" });
    expect(feed.info()).toMatchObject({ supported: false, reason: "unsupported" });
    expect(statSync(f).atimeMs).toBe(before);                              // not even opened by the service
    expect(shape(compose("w", true))).toBe("user act:live:status:0");
    expect(shape(compose("w", false))).toBe("user");
  });
  it("the service never stat's a path that cannot be read: a codex path that does not exist answers the same", async () => {
    await feedFor({ backend: "codex", path: "/nonexistent/rollout.jsonl", format: "codex" });
    expect(act.activityInfo("w")).toMatchObject({ supported: false, reason: "unsupported" });
    expect(shape(compose("w", true))).toBe("user act:live:status:0");
  });
});

describe.each([
  ["muse", { backend: "muse", path: null, format: null, reason: "unsupported" }],
  ["opencode", { backend: "opencode", path: null, format: null, reason: "unsupported" }],
  ["kiro-cli", { backend: "kiro-cli", path: null, format: null, reason: "kiro_session_unobservable" }],
  ["antigravity (no parser on this line)", { backend: "antigravity", path: null, format: null, reason: "unsupported" }],
  ["grok (no parser on this line)", { backend: "grok", path: null, format: null, reason: "unsupported" }],
] as Array<[string, LogSource]>)("%s: no transcript format", (_n, src) => {
  it("status line while busy; none when not busy", async () => {
    await feedFor(src);
    expect(act.activityInfo("w")).toMatchObject({ supported: false });
    expect(shape(compose("w", true))).toBe("user act:live:status:0");
    expect(shape(compose("w", false))).toBe("user");
  });
});

describe("the line", () => {
  it("counts from when the page saw the agent start (the working bar's clock); else from the last prompt", async () => {
    await feedFor({ backend: "muse", path: null, format: null, reason: "unsupported" });
    expect(compose("w", true, NOW - 7_000)[1].group).toMatchObject({ from: NOW - 7_000, statusOnly: true, busy: true, ended: false, items: [] });
    expect(compose("w", true)[1].group.from).toBe(Date.parse(rows[0]!.ts));
  });
  it("it is not hidden as empty, and says the steps are not shown here", async () => {
    await feedFor({ backend: "muse", path: null, format: null, reason: "unsupported" });
    expect(act.isEmptyGroup(compose("w", true)[1].group, { thinking: false })).toBe(false);
  });
  it("tool_progress off for the agent: no line, whatever the backend (the owner turned the chat's activity off)", async () => {
    await feedFor({ backend: "muse", path: null, format: null, reason: "unsupported" }, "off");
    expect(shape(compose("w", true))).toBe("user");
  });
  it("before the first answer there is no line (not a guess)", () => {
    expect(shape(compose("never-read", true))).toBe("user");
  });
});

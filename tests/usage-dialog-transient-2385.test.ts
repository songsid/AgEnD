/**
 * #2385: the usage dialog (and the rail: one component) flashed "Could not load usage data." with Try again over the
 * numbers it was showing whenever one read failed — a dropped request, a 500/502, a lapsed session. A failed read now
 * keeps the last good numbers with a quiet "couldn't refresh" note; the full error shows only when nothing was ever
 * read. The 60 s tick, the re-read after a `refreshing` snapshot and Refresh all go through the same read.
 * /api/ai-usage is a scripted fake: no server, no vendor call.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const iso = (ms: number) => new Date(ms).toISOString();
const snapshot = (used: number, extra: Record<string, unknown> = {}) => ({
  fetchedAt: iso(Date.now()), ...extra,
  providers: [{ id: "claude", name: "Claude", status: "ok", plan: "Max", metrics: [{ type: "percent", label: "5-hour", used }] }],
});
type Answer = { ok: boolean; status: number; body?: unknown; bodyFails?: boolean } | "throw";
const ok = (body: unknown): Answer => ({ ok: true, status: 200, body });

let usage: any, i18n: any, pg: AppPage | null = null;
let answers: Answer[] = [], reads: string[] = [];
function script(...next: Answer[]) {
  answers = next; reads = [];
  (globalThis as any).fetch = async (url: string) => {
    reads.push(url);
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a === "throw") throw new TypeError("Failed to fetch");
    return { ok: a.ok, status: a.status, headers: { get: () => null },
      json: async () => { if (a.bodyFails) throw new SyntaxError("Unexpected token <"); return a.body; } };
  };
}
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } i18n?.setLang("en"); });

const pct = () => (pg!.root.querySelector(".u-pct") as any)?.textContent ?? null;
const errorShown = () => pg!.root.textContent.includes("Could not load usage data.");
const note = () => (pg!.root.querySelector(".u-refresh-failed") as any)?.textContent ?? null;
const refresh = async () => {
  const btn = [...pg!.root.querySelectorAll("button")].find((b: any) => b.textContent === i18n.t("view.usageRefresh")) as any;
  btn.click();
  await settle(3);
};
async function mount(owner: string) {
  pg = page({ storage: { agend_tour_done: "1" } });
  await pg.mount(h(usage.UsageBody, { owner }));
  await settle(3);
}

describe("#2385 a failed read keeps the numbers already shown", () => {
  for (const [what, failure] of [
    ["a dropped request (fetch throws)", "throw"],
    ["a 500 with an { error } body", { ok: false, status: 500, body: { error: "the fleet config cannot be read" } }],
    ["a proxy's HTML 502 page", { ok: false, status: 502, bodyFails: true }],
    ["a 200 without providers", ok({ error: "partial" })],
  ] as Array<[string, Answer]>) {
    it(`${what}: the last numbers stay, with a quiet note — never the error state`, async () => {
      script(ok(snapshot(42)), failure);
      await mount(`t2385-${what}`);
      expect([pct(), note(), errorShown()]).toEqual(["42%", null, false]);
      await refresh();                                         // the read that fails
      expect(reads.length).toBe(2);
      expect([pct(), note(), errorShown()]).toEqual(["42%", "Couldn't refresh — showing the last numbers", false]);
    });
  }

  it("the next good read replaces them and the note goes", async () => {
    script(ok(snapshot(42)), "throw", ok(snapshot(57)));
    await mount("t2385-recover");
    await refresh();
    expect([pct(), note()]).toEqual(["42%", "Couldn't refresh — showing the last numbers"]);
    await refresh();
    expect([pct(), note(), errorShown()]).toEqual(["57%", null, false]);
  });

  it("the re-read after a `refreshing` snapshot failing: the snapshot stays, no error, and it does not keep re-reading", async () => {
    script(ok(snapshot(42, { refreshing: true })), { ok: false, status: 500, body: { error: "fetch failed" } });
    await mount("t2385-refreshing");
    expect(pg!.root.querySelector(".u-refreshing")).not.toBeNull();
    await new Promise(r => setTimeout(r, 4_300));              // the #1585 re-read, 4 s on
    await settle(3);
    expect([pct(), note(), errorShown(), pg!.root.querySelector(".u-refreshing")]).toEqual(["42%", "Couldn't refresh — showing the last numbers", false, null]);
    const after = reads.length;
    await new Promise(r => setTimeout(r, 4_300));
    expect(reads.length, "no 4 s loop on a failed refresh").toBe(after);
  }, 15_000);

  // Fable on #2386: a read superseded by Refresh is dropped — its later failure (its fetch aborted) is no failed read.
  it("a read superseded by Refresh that then fails shows no note over the newer numbers", async () => {
    script(ok(snapshot(42)));
    await mount("t2385-superseded");
    let rejectOld!: (e: Error) => void;
    (globalThis as any).fetch = async () => new Promise((_res, rej) => { rejectOld = rej; });   // read A, left hanging
    await refresh();
    script(ok(snapshot(57)));                                  // Refresh again: read B supersedes A and lands
    await refresh();
    expect([pct(), note()]).toEqual(["57%", null]);
    rejectOld(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    await settle(3);
    expect([pct(), note(), errorShown()]).toEqual(["57%", null, false]);
  });

  it("in Traditional Chinese the note reads 無法更新，顯示上次的數據", async () => {
    i18n.setLang("zh-TW");
    script(ok(snapshot(42)), "throw");
    await mount("t2385-zh");
    await refresh();
    expect([note(), pg!.root.textContent.includes("無法載入用量資料。")]).toEqual(["無法更新，顯示上次的數據", false]);
  });
});

describe("#2385 nothing read yet", () => {
  it("a first read that fails shows the full error with Try again; Try again recovers", async () => {
    script({ ok: false, status: 500, body: { error: "boom" } }, ok(snapshot(42)));
    await mount("t2385-first");
    expect([errorShown(), pct()]).toEqual([true, null]);
    const retry = [...pg!.root.querySelectorAll("button")].find((b: any) => b.textContent === i18n.t("app.retry")) as any;
    retry.click();
    await settle(3);
    expect([errorShown(), pct(), note()]).toEqual([false, "42%", null]);
  });
});

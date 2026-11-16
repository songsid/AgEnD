import { describe, expect, it, vi } from "vitest";
import { announcePostLoginRecovery, POST_LOGIN_RECOVERY_DEADLINE_MS } from "../src/login-controller.js";
import { runBeforeDeadline } from "../src/deadline.js";
import { t } from "../src/locale.js";

/**
 * A user re-logged in successfully and then saw nothing at all — no "login
 * worked", no progress, no result — concluded the login flow had hung, and
 * restarted the instances by hand. The login had in fact succeeded: the
 * success message was only BUILT after `await recoverBackendInstances(...)`
 * returned, and that was an unbounded sequential loop over every instance of
 * the backend. One slow restart therefore suppressed the news of a login that
 * had already worked.
 */
describe("post-login recovery always reports an outcome", () => {
  // M-3238: the dashboard's dialog gets the same outcome as data (it says it in one plain line); a broken reader never
  // stops the chat's report.
  it("hands the outcome to a reader too: what came back, what is still coming, or that it could not be done", async () => {
    const seen: unknown[] = [], sent: string[] = [];
    await announcePostLoginRecovery("codex", async () => ({ woken: ["a"], restarted: ["b"], pending: [] }), async (x) => { sent.push(x); }, 90_000, (o) => seen.push(o));
    await announcePostLoginRecovery("codex", async () => ({ woken: [], restarted: [], pending: ["slow"] }), async (x) => { sent.push(x); }, 90_000, (o) => seen.push(o));
    await announcePostLoginRecovery("codex", async () => { throw new Error("busy"); }, async (x) => { sent.push(x); }, 90_000, (o) => seen.push(o));
    expect(seen).toEqual([
      { woken: ["a"], restarted: ["b"], pending: [], failed: false },
      { woken: [], restarted: [], pending: ["slow"], failed: false },
      { woken: [], restarted: [], pending: [], failed: true },
    ]);
    expect(sent).toHaveLength(3);
    const quiet: string[] = [];
    await announcePostLoginRecovery("codex", async () => ({ woken: [], restarted: [], pending: [] }), async (x) => { quiet.push(x); }, 90_000, () => { throw new Error("reader broke"); });
    expect(quiet).toEqual([t("login.recovered_none")]);
  });

  it("reports what came back", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => ({ woken: ["a"], restarted: ["b"], pending: [] }),
      async text => { sent.push(text); },
    );
    expect(sent).toEqual([t("login.recovered", "a, b")]);
  });

  it("names the instances still restarting instead of going silent", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => ({ woken: [], restarted: ["b"], pending: ["slow-1", "slow-2"] }),
      async text => { sent.push(text); },
      90_000,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("slow-1, slow-2");
    // It must not read as a failure: they are still coming back on their own.
    expect(sent[0]).toBe(t("login.recover_pending", "90", "slow-1, slow-2"));
  });

  // The report is the last thing standing between the user and silence, so it
  // has to survive the step it is reporting on.
  it("still reports when recovery itself throws", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => { throw new Error("fleet busy"); },
      async text => { sent.push(text); },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(t("login.recover_failed", "fleet busy"));
  });

  // M-3249 (the leader, after #4051): chat's outcome is one plain line, as the dialog says it — the agents by the name
  // people see, woke and restarted alike "reloaded"; no "instance", no ✅ repeating the headline, no backticks, and in
  // Chinese no 已喚醒 / 已重啟. The dialog's data keeps the instance names (it maps them itself).
  it.each(["en", "zh-TW"] as const)("one plain line per outcome, agents by display name (%s)", async (lang) => {
    const { setLocale, getLocale } = await import("../src/locale.js");
    const before = getLocale();
    setLocale(lang);
    try {
      const label = (n: string) => ({ "agent-a": "Weaver", "agent-c": "砌光" } as Record<string, string>)[n] ?? n;
      const lines: string[] = [], seen: unknown[] = [];
      const say = async (r: () => Promise<any>) => announcePostLoginRecovery("codex", r, async (x) => { lines.push(x); }, 90_000, (o) => seen.push(o), label);
      await say(async () => ({ woken: ["agent-b"], restarted: ["agent-a", "agent-c"], pending: [] }));
      await say(async () => ({ woken: [], restarted: [], pending: [] }));
      await say(async () => ({ woken: [], restarted: [], pending: ["agent-a"] }));
      await say(async () => { throw new Error("fleet busy"); });
      await announcePostLoginRecovery("codex", async () => ({ woken: ["agent-a"], restarted: [], pending: [] }), async (x) => { lines.push(x); }, 90_000, undefined, () => { throw new Error("label broke"); });
      expect(lines).toEqual(lang === "en" ? [
        "Reloaded to use it: agent-b, Weaver, 砌光. You can talk to them again now.",
        "No agent uses it yet, so nothing needed reloading.",
        "Still reloading after 90s: Weaver. They come back on their own — no need to restart anything by hand.",
        "The agents that use it could not be reloaded automatically (fleet busy). If one does not answer, use /restart.",
        "Reloaded to use it: agent-a. You can talk to them again now.",
      ] : [
        "已重新載入，改用這個帳號：agent-b, Weaver, 砌光。現在可以正常對話了。",
        "目前沒有 Agent 使用它，不需要重新載入。",
        "等了 90 秒還在重新載入：Weaver。它們會自己恢復，不需要手動重啟。",
        "無法自動重新載入使用它的 Agent（fleet busy）。如果有 Agent 沒有回應，請用 /restart。",
        "已重新載入，改用這個帳號：agent-a。現在可以正常對話了。",
      ]);
      const headline = t("login.completed", "Codex");
      for (const line of [headline, ...lines]) expect(line).not.toMatch(/instance|`|已喚醒|已重啟|Woke|Restarted/);
      expect(lines.filter((l) => l.includes("✅")), "the headline alone carries the ✅").toEqual([]);
      expect(headline).toBe(lang === "en" ? "✅ Your Codex account is connected. Reloading the agents that use it…" : "✅ Codex 帳號已連接。正在重新載入使用這個帳號的 Agent…");
      expect(seen[0], "the dialog's data: instance names").toEqual({ woken: ["agent-b"], restarted: ["agent-a", "agent-c"], pending: [], failed: false });
    } finally { setLocale(before); }
  });

  it("uses a finite default deadline", () => {
    expect(POST_LOGIN_RECOVERY_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(POST_LOGIN_RECOVERY_DEADLINE_MS)).toBe(true);
  });
});

describe("runBeforeDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    const r = await runBeforeDeadline(async () => "done", Date.now() + 1_000);
    expect(r).toEqual({ status: "fulfilled", value: "done" });
  });

  it("gives up waiting on work that overruns, without cancelling it", async () => {
    let finished = false;
    const r = await runBeforeDeadline(
      () => new Promise<void>(resolve => setTimeout(() => { finished = true; resolve(); }, 50)),
      Date.now() + 5,
    );
    expect(r).toEqual({ status: "timeout" });
    // The work is still running — that is the contract: stop waiting, not stop working.
    expect(finished).toBe(false);
    await new Promise(r2 => setTimeout(r2, 80));
    expect(finished).toBe(true);
  });

  // Node clamps a setTimeout delay above 2^31-1 to 1ms, so a deadline far in
  // the future would fire at once and report everything as timed out.
  it("does not time out immediately when the deadline is very far away", async () => {
    const r = await runBeforeDeadline(
      () => new Promise<string>(resolve => setTimeout(() => resolve("done"), 10)),
      Date.now() + Number.MAX_SAFE_INTEGER,
    );
    expect(r).toEqual({ status: "fulfilled", value: "done" });
  });

  it("reports a rejection instead of throwing, and leaves no unhandled rejection", async () => {
    const r = await runBeforeDeadline(async () => { throw new Error("nope"); }, Date.now() + 1_000);
    expect(r.status).toBe("rejected");
  });

  it("does not surface a late rejection from abandoned work as unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const r = await runBeforeDeadline(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 20)),
        Date.now() + 5,
      );
      expect(r).toEqual({ status: "timeout" });
      await new Promise(res => setTimeout(res, 60));
      expect(unhandled, "an abandoned promise must still be observed").not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

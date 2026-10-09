import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * "Restart AgEnD" gave no feedback: the restart really happened, but the button stayed pressable, the
 * panel said "restart AgEnD to apply" while it was restarting, and nothing polled — so people pressed
 * it again. The cause was one line: the click handed the *stale* job (finished, "restart-required") to
 * the watcher, whose loop only runs while a job is "running", so it returned at once and re-drew a
 * fresh enabled button.
 *
 * Ported to the app shell (#1408 step 3): the Settings panel renders the operation card from the app
 * store, and the app-owned runner (settings-apply.js) owns the restart and its watch. These mount the real
 * panel in the fake DOM against scripted server answers, with the fetch that rejects while the fleet is down.
 */
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

type Answer = { ok: boolean; status: number; body: any } | "down";
const ok = (body: unknown, status = 200): Answer => ({ ok: true, status, body });
const JOB = "11111111-1111-4111-8111-111111111111";
const base = { id: JOB, key: "k", startedAt: 1, deadlineMs: 120000, pid: 1, elapsed_ms: 1000, overdue: false, message: "" };
const restartRequired = { ...base, status: "done", finishedAt: 2, targets: [{ target: "fleet", kind: "restart", status: "restart-required" }] };
const running = { ...base, status: "running", deadlineMs: 300000, targets: [{ target: "fleet", kind: "restart", status: "running" }] };
const settled = { ...base, status: "done", finishedAt: 3, targets: [{ target: "fleet", kind: "restart", status: "done", settled_by: "fleet-restart" }] };

let p: AppPage;
let calls: Array<{ path: string; method: string }> = [];
// A test's own answers; anything it does not script gets the page's ordinary reads.
let script: (path: string, method: string) => Answer | undefined | Promise<Answer | undefined> = () => undefined;
// The job the next Apply's POST answers with (applyJob), so a test can script its own restart answers as well.
let applyAnswer: Answer | null = null;
const reads = (path: string): Answer => {
  if (path === "/api/settings/fleet/raw") return ok({ defaults: {}, instances: {} });
  if (path === "/api/fleet") return ok({ instances: [], version: "2.0.0" });
  if (path === "/api/settings/connections" || path === "/api/settings/provider-secrets" || path === "/api/profiles") return ok([]);
  if (path === "/api/settings/classic") return ok({ channels: {}, defaults: {} });
  return { ok: false, status: 404, body: null };
};

let runner: any, app: any, settings: any, toastMod: any, tr: (k: string, ...a: unknown[]) => string;
const tn = (k: string, ...a: unknown[]) => tr(`settings.${k}`, ...a);

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings" });
  (globalThis as any).fetch = async (path: string, init: { method?: string } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method });
    const scripted = await script(path, method);
    const answer = scripted ?? (method === "POST" && path === "/api/settings/apply" && applyAnswer ? applyAnswer : reads(path));
    if (answer === "down") throw new TypeError("Failed to fetch");   // what fetch does while the server is restarting
    return { ok: answer.ok, status: answer.status, json: async () => answer.body };
  };
  ({ t: tr } = await import("/assets/app-i18n.js"));
  app = await import("/assets/app-store.js");
  runner = await import("/ui/js/settings-apply.js");
  settings = await import("/ui/js/panel-settings.js");
  toastMod = await import("/assets/ui-toast.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  calls = []; script = () => undefined; applyAnswer = null;
  (globalThis as any).confirm = vi.fn(() => true);     // the browser's confirm(): ask() in settings-dialogs.js
  runner.resetOperation();
  await p.unmount();
});
afterEach(async () => {
  runner.resetOperation();
  await p.unmount();
});

const mountSettings = (section = "agents") => p.mount(
  h("div", null,
    h(settings.SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}|1|en` }),
    h(toastMod.Toasts, null)));
const buttons = (within: any = p.root) => [...within.querySelectorAll("button")] as any[];
const card = () => p.root.querySelector(".s-op") as any;
const cardButton = () => buttons(card()).find((b: any) => b.textContent === tn("restartFleetButton") || b.textContent === tn("restartFleetBusy"));
/** A press the way a browser makes it: a disabled button takes no click. */
async function press(button: any) {
  if (button.disabled) return;
  button.click();
  await settle();
}
const toasts = () => p.root.querySelectorAll(".toast").map((el: any) => ({ text: el.textContent, error: el.className.includes("err") }));
/** Put a job in hand: the app's runner posts it, and the card renders what it publishes. */
async function applyJob(job: unknown) {
  applyAnswer = ok(job, 202);
  runner.startOperation([]);
  await settle();
  await vi.waitFor(() => expect(runner.operationActive()).toBe(false));
  await settle();
}
const restartPath = (c: { path: string }) => c.path === "/api/settings/restart-fleet";

describe("Restart AgEnD gives feedback and cannot be pressed twice", () => {
  it("disables the button and says so the moment it is pressed — before the server has answered", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    script = async (path, method) => {
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); }
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    const button = cardButton();
    expect(button.textContent).toBe(tn("restartFleetButton"));
    expect(button.disabled).toBe(false);

    const pending = press(button);
    await settle();
    expect(cardButton().disabled).toBe(true);
    expect(cardButton().textContent).toBe(tn("restartFleetBusy"));
    release(); await pending;
  });

  it("presses once: a second press while it is under way neither asks again nor posts again", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    script = async (path, method) => {
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); }
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    const first = press(cardButton());
    await settle();
    await press(cardButton()); await press(cardButton());
    release(); await first;

    expect(calls.filter(restartPath)).toHaveLength(1);
    expect((globalThis as any).confirm).toHaveBeenCalledTimes(1);
    expect(runner.operationActive()).toBe(false);
  });

  it("watches the job the server moved to 'running', not the finished one it was holding — and keeps waiting while the fleet is down", async () => {
    const answers: Answer[] = [ok(running), ok(running), "down", "down", "down", ok(settled)];
    script = (path, method) => {
      if (path.endsWith("/restart-fleet")) return ok({ job_id: JOB, restarting: true }, 202);
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path === `/api/settings/apply/${JOB}`) return answers.shift() ?? ok(settled);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    const reloadsBefore = calls.filter(c => c.path === "/api/settings/fleet/raw").length;
    await press(cardButton());
    // Announced when the server accepts it (a toast lasts 4 s, the restart longer), as the old page's banner was.
    await vi.waitFor(() => expect(toasts().map((t: { text: string }) => t.text)).toContain(tn("restartFleetStarted")));
    await vi.waitFor(() => expect(runner.operationActive()).toBe(false), { timeout: 15_000 });
    await settle();

    const gets = calls.filter(c => c.method === "GET" && c.path.startsWith("/api/settings/apply/"));
    expect(gets.length).toBeGreaterThanOrEqual(6);        // it polled — through three failed fetches
    expect(gets.every(c => c.path === `/api/settings/apply/${JOB}`)).toBe(true);
    // It ended on the settled job: applied, no stale "restart to apply" and no button.
    expect(card().querySelector("strong").textContent).toBe(tn("applyDone"));
    expect(card().querySelector("p.note")).toBeNull();
    expect(cardButton()).toBeUndefined();
    // The page refreshes itself once AgEnD is back.
    expect(calls.filter(c => c.path === "/api/settings/fleet/raw").length - reloadsBefore).toBe(1);
  }, 20_000);

  it("believes the server's own account of the job: one already settled is shown as applied without waiting", async () => {
    script = (path, method) => {
      if (path.endsWith("/restart-fleet")) return ok({ job_id: JOB, restarting: true }, 202);
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path === `/api/settings/apply/${JOB}`) return ok(settled);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    await press(cardButton());

    expect(calls.filter(c => c.method === "GET" && c.path.startsWith("/api/settings/apply/"))).toHaveLength(1);   // the one fetch that asked
    expect(card().querySelector("strong").textContent).toBe(tn("applyDone"));
  });

  it("shows 'restarting' — title, note and row — while the job is running, and never 'restart to apply'", async () => {
    // The job stays running: its watch keeps polling it (the store holds the job, the card renders it).
    script = (path, method) => {
      if (method === "POST" && path === "/api/settings/apply") return ok(running, 202);
      if (path === `/api/settings/apply/${JOB}`) return ok(running);
      return undefined;
    };
    await mountSettings();
    runner.startOperation([]);
    await vi.waitFor(() => expect(app.appStore.get().settingsOp?.job?.status).toBe("running"));
    await settle();
    expect(card().querySelector("strong").textContent).toBe(tn("restartFleetTitle"));
    expect(card().querySelector("p.note").textContent).toBe(tn("restartFleetWaiting"));
    expect(card().textContent).toContain(tn("restartFleetTitle"));
    expect(card().textContent).not.toContain(tn("applyRestartNeeded"));
    expect(cardButton()).toBeUndefined();
  });

  it("gives the button back, with its own label and the reason, when the server refuses", async () => {
    script = (path, method) => {
      if (path.endsWith("/restart-fleet")) return { ok: false, status: 429, body: { error: "AgEnD was restarted from Settings very recently", retry_after_seconds: 600 } };
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    await press(cardButton());

    expect(cardButton().disabled).toBe(false);
    expect(cardButton().textContent).toBe(tn("restartFleetButton"));
    expect(toasts().at(-1)).toEqual({
      text: tn("restartFleetRateLimited", "AgEnD was restarted from Settings very recently", 10), error: true,
    });
    expect(calls.filter(c => c.method === "GET" && c.path.startsWith("/api/settings/apply/"))).toEqual([]);   // nothing to watch: no restart began
    expect(runner.operationActive()).toBe(false);
    await press(cardButton());                                       // a later press can try again
    expect(calls.filter(restartPath)).toHaveLength(2);
  });

  it("gives the button back when the request itself cannot be made", async () => {
    script = (path, method) => {
      if (path.endsWith("/restart-fleet")) return "down";
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    await press(cardButton());

    expect(cardButton().disabled).toBe(false);
    expect(cardButton().textContent).toBe(tn("restartFleetButton"));
    expect(toasts().at(-1)!.error).toBe(true);
    expect(runner.operationActive()).toBe(false);
  });

  it("re-draws a disabled 'restarting' button if the panel is redrawn mid-restart", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    script = async (path, method) => {
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); }
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    const pending = press(cardButton());
    await settle();

    // Something else redraws the panel while the restart is still under way: a fresh card, from the store.
    await p.unmount();
    await mountSettings();
    expect(cardButton().disabled).toBe(true);
    expect(cardButton().textContent).toBe(tn("restartFleetBusy"));
    release(); await pending;
  });

  it("keeps the restart a separate request: a single Apply never posts it", async () => {
    script = (path, method) => (method === "POST" && path === "/api/settings/apply") ? ok(restartRequired, 202) : undefined;
    await mountSettings();
    await applyJob(restartRequired);

    expect(calls.filter(restartPath)).toEqual([]);
  });

  it("hides the button when a restart could not clear the row (fleet signature mismatch)", async () => {
    script = (path, method) => {
      if (path === "/api/settings/schema") return ok({ fleet_signature_mismatch: ["defaults.locale"] });
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);

    expect(cardButton()).toBeUndefined();
    expect(card().querySelector("p.note").textContent).toBe(tn("signatureMismatch", "defaults.locale"));
  });

  it("the restart's own confirmation is the page's, and refusing it sends nothing", async () => {
    script = (path, method) => (method === "POST" && path === "/api/settings/apply") ? ok(restartRequired, 202) : undefined;
    (globalThis as any).confirm = vi.fn(() => false);
    try {
      await mountSettings();
      await applyJob(restartRequired);
      await press(cardButton());

      expect((globalThis as any).confirm).toHaveBeenCalledWith(tn("restartFleetConfirm"));
      expect(calls.filter(restartPath)).toEqual([]);
    } finally {
      (globalThis as any).confirm = vi.fn(() => true);
    }
  });

  // Lost in the port: the old page showed a "Changes applied" banner when the restart settled. The card's own
  // title says it now, but no toast is raised. Kept failing on purpose until the panel raises it again.
  it("announces 'Changes applied' as a toast once the restart settles (old page's banner)", async () => {
    script = (path, method) => {
      if (path.endsWith("/restart-fleet")) return ok({ job_id: JOB, restarting: true }, 202);
      if (method === "POST" && path === "/api/settings/apply") return ok(restartRequired, 202);
      if (path === `/api/settings/apply/${JOB}`) return ok(settled);
      return undefined;
    };
    await mountSettings();
    await applyJob(restartRequired);
    await press(cardButton());

    expect(toasts().at(-1)).toEqual({ text: tn("changesApplied"), error: false });
  });
});

describe("Start / Stop / Pause / Wake show that they are working and cannot be repeated", () => {
  // alpha is running, beta is stopped: each has its own row with its own lifecycle button.
  const fleet = ok({ version: "2.0.0", instances: [
    { name: "alpha", status: "running", state: "idle" },
    { name: "beta", status: "stopped", state: null },
  ] });
  const withAgents = (work: (path: string) => Answer | Promise<Answer> | undefined) => {
    script = (path, method) => {
      if (path === "/api/fleet") return fleet;
      if (path === "/api/settings/fleet/raw") return ok({ defaults: {}, instances: { alpha: { working_directory: "/tmp/a" }, beta: { working_directory: "/tmp/b" } } });
      if (method === "POST") return work(path);
      return undefined;
    };
  };
  const row = (name: string) => (p.root.querySelectorAll(".s-row") as any[]).find(r => r.querySelector(".s-name")?.textContent === name);

  it("disables the pressed agent's buttons and labels the pressed one while the request is in flight", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    withAgents(async () => { await gate; return ok({}); });
    await mountSettings();
    await vi.waitFor(() => expect(row("alpha")).toBeDefined());
    const stop = buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!;
    const pending = press(stop);
    await settle();

    expect(buttons(row("alpha")).find((b: any) => b.textContent === tn("working"))!.disabled).toBe(true);
    expect(buttons(row("beta")).some((b: any) => b.disabled)).toBe(false);   // a different agent is not held up
    release(); await pending;
    await vi.waitFor(() => expect(buttons(row("alpha")).some((b: any) => b.textContent === tn("stop"))).toBe(true), { timeout: 5000 });
    expect(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!.disabled).toBe(false);
  }, 15_000);

  // Lost in the port: the old page disabled the agent's Settings button while its action ran; the panel disables
  // only the lifecycle button. Kept failing on purpose until the panel does it again.
  it("also disables the agent's Settings button while its action runs (old page)", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    withAgents(async () => { await gate; return ok({}); });
    await mountSettings();
    await vi.waitFor(() => expect(row("alpha")).toBeDefined());
    const pending = press(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!);
    await settle();

    expect(buttons(row("alpha")).find((b: any) => b.textContent === tn("settingsButton"))!.disabled).toBe(true);
    release(); await pending;
  });

  it("sends one request per agent at a time, however often it is pressed, and a different agent is not held up", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    withAgents(async (path) => { if (path === "/stop/alpha") await gate; return ok({}); });
    await mountSettings();
    await vi.waitFor(() => expect(row("alpha")).toBeDefined());
    const stop = () => buttons(row("alpha")).find((b: any) => b.textContent === tn("stop") || b.textContent === tn("working"))!;
    const first = press(stop());
    await settle();
    await press(stop());
    release(); await first;
    await settle();

    expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/stop/alpha"]);
    // ...and a different agent is not held up by it
    await press(buttons(row("beta")).find((b: any) => b.textContent === tn("start"))!);
    await vi.waitFor(() => expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/stop/alpha", "/api/instance/beta/start"]), { timeout: 5000 });
  }, 15_000);

  it("says when it failed instead of failing silently, and always frees the agent", async () => {
    withAgents(async () => ({ ok: false, status: 409, body: { error: "not running" } }));
    await mountSettings();
    await vi.waitFor(() => expect(row("alpha")).toBeDefined());
    await press(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!);
    await vi.waitFor(() => expect(toasts().at(-1)).toEqual({
      text: `${tn("actionFailed", tn("stop"))}: not running`, error: true,
    }), { timeout: 5000 });
    // The pressed button says it is working until the request and its short settle wait are over.
    await vi.waitFor(() => expect(buttons(row("alpha")).some((b: any) => b.textContent === tn("stop"))).toBe(true), { timeout: 5000 });
    const stop = buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!;
    expect(stop.disabled).toBe(false);
    await press(stop);                                       // freed: can be tried again
    await vi.waitFor(() => expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/stop/alpha", "/stop/alpha"]), { timeout: 5000 });
  }, 15_000);

  it("frees the agent even if the request throws", async () => {
    let n = 0;
    withAgents(async () => { if (n++ === 0) return "down"; return ok({}); });
    await mountSettings();
    await vi.waitFor(() => expect(row("alpha")).toBeDefined());
    await press(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!);
    await vi.waitFor(() => expect(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!.disabled).toBe(false), { timeout: 5000 });
    await press(buttons(row("alpha")).find((b: any) => b.textContent === tn("stop"))!);
    await vi.waitFor(() => expect(calls.filter(c => c.method === "POST")).toHaveLength(2), { timeout: 5000 });
  }, 15_000);
});

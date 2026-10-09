/**
 * Settings P0 redesign shell (#1408 step 3: the Settings panel of the app shell, rendered in the mini DOM with a fake
 * fetch standing in for the server):
 * - Two levels: what is shown, and one drawer per object. No global "show advanced" mode; the Developer YAML stays.
 * - The pending-change bar with the human impact labels, and Apply, which hands the staged changes to the runner.
 * - Tool progress: defaults and overrides are staged; Apply asks the server for one job (Idempotency-Key) and watches it.
 * - The reply completion guard: the rule (settings-model.js) and what the General and agent forms show.
 * - ClassicBot: who can use it, and a room's edit is a PATCH to its channel.
 * - Primary access mode and allowed users, with the lockout confirmations asked at Apply time.
 * - Shortened names with the effective model and effort; the zh-TW strings of the states above.
 * - An unsupported provider verifier gets no key input at all (fail-closed).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { replyGuardSupported } from "/ui/js/settings-model.js";

interface Sent { method: string; path: string; body: any; headers: Record<string, string> }
interface World { fleet: any; classic: any; instances: Record<string, any>; connections: any[]; providerSecrets: any[] }

const schema = buildSettingsImpactSchema();
let p: AppPage;
let w: World;
let sent: Sent[] = [];
let confirmAnswer = true;
let confirmed: string[] = [];
/** The writes a test expects: answers for anything that is not a read. */
let answer: (method: string, path: string, body: any) => { status?: number; body?: unknown } | undefined = () => undefined;

const fakeFetch = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  sent.push({ method, path, body, headers: init.headers ?? {} });
  const r = answer(method, path, body) ?? reads(method, path) ?? {};
  const status = r.status ?? 200;
  return { ok: status < 400, status, json: async () => r.body ?? {} };
};
/** What the panel reads when it mounts, and again after an Apply. */
function reads(method: string, path: string): { body: unknown; status?: number } | undefined {
  if (method !== "GET") return undefined;
  if (path === "/api/settings/schema") return { body: schema };
  if (path === "/api/settings/fleet/raw") return w.fleet === null ? { status: 500, body: {} } : { body: w.fleet };
  if (path === "/api/settings/classic") return { body: w.classic };
  if (path === "/api/settings/connections") return { body: w.connections };
  if (path === "/api/settings/provider-secrets") return { body: w.providerSecrets };
  if (path === "/api/fleet") return { body: { version: "2.1.12", instances: Object.entries(w.instances).map(([name, i]) => ({ name, ...i })) } };
  if (path === "/api/profiles" || path === "/api/settings/pending") return { body: [] };
  if (path === "/api/settings/status-emojis") return { body: { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] } };
  return undefined;
}
const world = (over: Partial<World> = {}): World => ({
  fleet: { defaults: { backend: "claude-code", locale: "en", tool_progress: "off", log_level: "info" }, instances: {}, channels: [] },
  classic: { channels: {}, defaults: {} },
  instances: {},
  connections: [],
  providerSecrets: [],
  ...over,
});
/** The writes that succeed: a PUT/PATCH/DELETE answers 200; the Apply answers a job that is still running, and its watch then sees it done. */
const succeed = (method: string, path: string) => {
  if (method === "POST" && path === "/api/settings/apply") return { body: { id: "job-1", status: "running", targets: [] } };
  if (method === "GET" && path === "/api/settings/apply/job-1") return { body: { id: "job-1", status: "done", targets: [] } };
  return method !== "GET" ? { body: { ok: true } } : undefined;
};

const realFetch = (globalThis as any).fetch;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings" });
  (globalThis as any).fetch = fakeFetch;
});
afterAll(() => {
  p.restore();
  (globalThis as any).fetch = realFetch;
});
beforeEach(() => {
  w = world(); sent = []; answer = () => undefined; confirmed = []; confirmAnswer = true;
  // ask() in settings-dialogs.js answers through the page's global confirm(); the window object is the same host.
  const answerConfirm = (msg: string) => { confirmed.push(msg); return confirmAnswer; };
  (globalThis as any).confirm = answerConfirm;
  p.window.confirm = answerConfirm;
});
afterEach(async () => {
  await p.unmount();
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en");
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

const mountSettings = async (section = "agents") => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();                                  // a fresh visit: the panel reads the configuration again
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(12);
};
const buttons = (label: string, root: any = p.root): any[] => root.querySelectorAll("button").filter((b: any) => b.textContent.trim() === label);
const button = (label: string, root: any = p.root) => { const found = buttons(label, root); expect(found.length, `button ${label}`).toBeGreaterThan(0); return found[0]; };
const click = async (el: any) => { fire(el, "click"); await settle(); };
/** A checkbox: its state changes and the browser fires change (not click, which a mini DOM does not turn into one). */
const check = async (el: any, on = !el.checked) => { el.checked = on; fire(el, "change"); await settle(); };
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
const choose = async (el: any, value: string) => { el.value = value; fire(el, "change"); await settle(); };
const pending = () => p.root.querySelector("[role=region]");
/** Wait until the app's Apply runner is no longer writing or watching (a running job is polled once a second). */
const untilIdle = async () => {
  const { appStore } = await import("/assets/app-store.js");
  const busy = () => ["writing", "posting", "watching"].includes(appStore.get().settingsOp?.phase);
  for (let start = Date.now(); busy() && Date.now() - start < 5000;) await new Promise(r => setTimeout(r, 20));
  expect(busy(), "the Apply finished").toBe(false);
};
/** The staged-change bar's Apply; the test waits for the operation it starts to finish. */
const applyStaged = async () => { await click(button("Apply changes", pending())); await untilIdle(); };
const writes = () => sent.filter(s => s.method !== "GET");

describe("Settings P0 redesign shell", () => {
  it("keeps advanced settings one click away and the YAML escape hatch intact", async () => {
    w = world({
      fleet: { defaults: { backend: "claude-code" }, instances: { "alpha-t1": { backend: "claude-code", working_directory: "/w", channel_id: "dc" } },
        channels: [{ id: "dc", type: "discord", bot_token_env: "T", access: { mode: "locked", allowed_users: [] } }] },
      instances: { "alpha-t1": { status: "running", backend: "claude-code" } },
    });
    await mountSettings("agents");
    // No global "show advanced" mode anywhere on the page.
    expect(p.root.getElementById("advancedToggle")).toBeNull();
    expect(p.root.querySelectorAll(".advanced-only")).toHaveLength(0);
    // Per object: an agent's dialog has its own drawer, titled "Advanced".
    await click(button("Settings"));
    const drawers = p.root.querySelectorAll("details.drawer");
    expect(drawers.map((d: any) => d.querySelector("summary")?.textContent)).toContain("Advanced");
    // The escape hatch stays: the Developer section shows the fleet as YAML, editable and applied as one operation.
    await mountSettings("advanced");
    const yaml = p.root.querySelector("pre.s-yaml")!;
    expect(yaml).not.toBeNull();
    expect(yaml.textContent).toContain("defaults:");
    expect(yaml.textContent).toContain("instances:");
    expect(button("Edit")).toBeTruthy();
    expect(buttons("YAML").length).toBeGreaterThan(0);
  });

  it("provides the global pending-change apply bar and human impact labels", async () => {
    await mountSettings("general");
    expect(pending()).toBeNull();
    // An instance-level default (model): the bar names the costliest kind staged.
    await type(p.root.querySelector("#g-model"), "claude-opus-4-8");
    await click(button("Review changes"));
    const bar = pending()!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain("1 change(s) not applied");
    expect(bar.textContent).toContain("Restart this Agent");
    expect(bar.textContent).not.toContain("Restart AgEnD");
    expect(button("Apply changes", bar)).toBeTruthy();
    expect(button("Discard", bar)).toBeTruthy();
  });

  it("stages tool-progress defaults and overrides, then requests a hot reload", { timeout: 15_000 }, async () => {
    w = world({ fleet: { defaults: { backend: "claude-code", locale: "en", tool_progress: "off" },
      instances: { "alpha-t1": { backend: "claude-code", working_directory: "/w", tool_progress: "standard" } }, channels: [] },
      instances: { "alpha-t1": { status: "running" } } });
    answer = succeed;
    await mountSettings("agents");
    // The override: a value the instance sets is shown and staged as that value; "inherit" sends null.
    await click(button("Settings"));
    const select = p.root.querySelector("#ag-tool_progress")!;
    expect(select.value).toBe("standard");
    expect(select.disabled).toBe(false);
    await choose(select, "verbose");
    await click(button("Stage change"));
    await applyStaged();
    expect(writes().filter(s => s.path === "/api/settings/fleet/instances/alpha-t1")).toEqual([
      expect.objectContaining({ method: "PATCH", body: { tool_progress: "verbose" } }),
    ]);
    sent = [];
    // Then the default: the General form shows it, stages it, and Apply asks for one job (watched, keyed).
    await mountSettings("general");
    const defaults = p.root.querySelector("#g-tp")!;
    expect(defaults.value).toBe("off");
    await choose(defaults, "standard");
    await click(button("Review changes"));
    expect(pending()!.textContent).toContain("Immediately");       // tool progress is a hot setting
    await applyStaged();
    const put = writes().find(s => s.path === "/api/settings/fleet/defaults")!;
    expect(put).toMatchObject({ method: "PUT", body: { tool_progress: "standard" } });
    const apply = writes().find(s => s.path === "/api/settings/apply")!;
    expect(apply.headers["Idempotency-Key"]).toBeTruthy();
    expect(apply.body).toEqual({ idempotency_key: apply.headers["Idempotency-Key"] });
    expect(writes().indexOf(apply)).toBeGreaterThan(writes().indexOf(put));
    expect(sent.filter(s => s.method === "GET" && s.path === "/api/settings/apply/job-1")).not.toHaveLength(0);
    expect(p.root.querySelector(".s-op")!.textContent).toContain("Changes applied");
  });

  it("the agent override's inherit toggle sends null, not the picked value", async () => {
    w = world({ fleet: { defaults: { backend: "claude-code", tool_progress: "off" },
      instances: { "alpha-t1": { backend: "claude-code", working_directory: "/w", tool_progress: "standard" } }, channels: [] },
      instances: { "alpha-t1": { status: "running" } } });
    answer = succeed;
    await mountSettings("agents");
    await click(button("Settings"));
    const field = p.root.querySelector("#ag-tool_progress")!.closest(".field")!;
    const inherit = field.querySelector("input[type=checkbox]")!;
    await check(inherit);
    expect(p.root.querySelector("#ag-tool_progress")!.disabled).toBe(true);
    await click(button("Stage change"));
    await applyStaged();
    expect(writes().filter(s => s.path.startsWith("/api/settings/fleet/instances/"))).toEqual([
      expect.objectContaining({ method: "PATCH", path: "/api/settings/fleet/instances/alpha-t1", body: { tool_progress: null } }),
    ]);
  });

  it("wires the reply completion guard: the rule, the General note, and the agent's kiro mode", async () => {
    // The rule itself: Claude Code in MCP mode; Kiro legacy or TUI in MCP mode; everything else stored but inactive.
    expect(replyGuardSupported("claude-code", "mcp")).toBe(true);
    expect(replyGuardSupported("claude-code", "cli")).toBe(false);
    for (const ui of [undefined, "legacy", "tui"]) expect(replyGuardSupported("kiro-cli", "mcp", ui)).toBe(true);
    for (const ui of ["v3", "unknown"]) expect(replyGuardSupported("kiro-cli", "mcp", ui)).toBe(false);
    expect(replyGuardSupported("kiro-cli", "cli", "legacy")).toBe(false);
    expect(replyGuardSupported("codex", "mcp")).toBe(false);

    // General: the note follows the picked backend, and the stored value is what the checkbox shows.
    await mountSettings("general");
    expect(p.root.querySelector("#g-be")!.value).toBe("claude-code");
    const general = p.root.querySelector(".s-general")!;
    expect(general.textContent).toContain("Available for Claude Code and Kiro legacy/TUI in MCP mode.");
    await choose(p.root.querySelector("#g-be")!, "codex");
    expect(p.root.querySelector(".s-general")!.textContent).toContain("Stored but inactive: codex in mcp mode does not support reply-drop recovery.");

    // An agent on Kiro with its UI set to v3: the agent's own form says the stored guard is inactive there.
    w = world({ fleet: { defaults: { backend: "claude-code", kiro_ui: "v3" }, instances: { "kiro-t2": { backend: "kiro-cli", working_directory: "/w" } }, channels: [] },
      instances: { "kiro-t2": { status: "running" } } });
    await mountSettings("agents");
    await click(button("Settings"));
    expect(p.root.querySelector("#ag-be")!.value).toBe("kiro-cli");
    expect(p.root.querySelector("dialog")!.textContent).toContain("Stored but inactive: kiro-cli in mcp mode does not support reply-drop recovery.");
  });

  it("surfaces the ClassicBot access and editable channel workflow", async () => {
    w = world({ classic: { channels: { "c1": { name: "ops", instanceName: "ops-t9", backend: "claude-code", model: "claude-opus-5-5", channelId: "1" } }, defaults: {} },
      instances: { "ops-t9": { status: "running", classic: true } } });
    answer = succeed;
    await mountSettings("general");
    const general = p.root.querySelector(".s-general")!;
    expect(general.textContent).toContain("Who can use ClassicBot");
    expect(general.textContent).toContain("ClassicBot default backend");
    // A room's edit is staged, and Apply sends it to that room's own channel.
    await mountSettings("classic");
    await click(button("Settings"));
    await type(p.root.querySelector("#cl-model"), "claude-haiku-5-5");
    await click(button("Stage change"));
    await applyStaged();
    expect(writes().find(s => s.method === "PATCH")).toMatchObject({ path: "/api/settings/classic/channels/c1", body: { model: "claude-haiku-5-5" } });
  });

  it("stages primary access mode and allowed users, and asks the lockout confirmations at Apply time", async () => {
    const channel = { id: "dc", type: "discord", bot_token_env: "DISCORD_TOKEN", group_id: "g1", access: { mode: "locked", allowed_users: [111] } };
    w = world({ fleet: { defaults: { backend: "claude-code" }, instances: {}, channels: [channel] } });
    answer = succeed;
    await mountSettings("bots");
    await click(button("Settings"));
    // Opening a locked connection: staged at once; the question is asked only when Apply runs.
    await choose(p.root.querySelector("#bot-mode")!, "open");
    await click(button("Stage change"));
    expect(confirmed).toEqual([]);
    expect(writes()).toEqual([]);
    await applyStaged();
    expect(confirmed).toEqual(["Open access allows anyone in this channel to operate the bot. Continue?"]);
    const put = writes().find(s => s.path === "/api/settings/fleet/channels")!;
    expect(put.body[0].access).toEqual({ mode: "open", allowed_users: [111] });

    // Locking a connection with nobody allowed warns in the dialog, and the Apply asks before anything is written.
    sent = []; confirmed = []; confirmAnswer = false;
    w = world({ fleet: { defaults: { backend: "claude-code" }, instances: {}, channels: [{ ...channel, access: { mode: "open", allowed_users: [111] } }] } });
    await mountSettings("bots");
    await click(button("Settings"));
    await choose(p.root.querySelector("#bot-mode")!, "locked");
    await click(p.root.querySelector(".chips-box")!.querySelector("button.chip-x"));
    expect(p.root.querySelector("dialog")!.textContent).toContain("Locked mode has no allowed users; add at least one administrator to avoid lockout.");
    await click(button("Stage change"));
    await applyStaged();
    expect(confirmed).toEqual(["Locked access has no allowed users. This may leave nobody able to administer the bot. Continue?"]);
    expect(writes()).toEqual([]);             // refused: nothing written, the change is not applied
  });

  it("shows shortened names plus the effective model and effort for fleet and ClassicBot agents", async () => {
    w = world({
      fleet: { defaults: { backend: "claude-code", model: "claude-sonnet-5-5" }, instances: { "alpha-t1": { backend: "claude-code", working_directory: "/w" } }, channels: [] },
      classic: { channels: {}, defaults: {} },
      instances: { "alpha-t1": { status: "running", model_display: "claude-opus-5-5[1m]", effort: "high", effort_supported: true } },
    });
    await mountSettings("agents");
    const row = p.root.querySelector(".s-row")!;
    expect(row.querySelector(".s-name")!.textContent).toBe("alpha");
    expect(row.querySelector(".s-meta")!.textContent).toBe("claude-opus-5-5[1m]");
    expect(row.textContent).toContain("effort: high");
    // A ClassicBot room: its own model when it has one; its effort from the defaults, as the room's runtime reports.
    w = world({ classic: { channels: { "c1": { name: "ops", instanceName: "ops-t9", backend: "claude-code", model: "claude-haiku-5-5" } }, defaults: {} },
      instances: { "ops-t9": { status: "running", classic: true } } });
    await mountSettings("classic");
    const room = p.root.querySelector(".s-row")!;
    expect(room.querySelector(".s-meta")!.textContent).toBe("claude-haiku-5-5");
    expect(room.textContent).toContain("effort: auto");
  });

  it("localizes the settings' validation, confirmation and empty-state text (zh-TW)", async () => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    w = world({ fleet: { defaults: { backend: "claude-code", locale: "en", tool_progress: "off", auto_pause_after: 0 }, instances: { "alpha-t1": { backend: "claude-code" } }, channels: [{ id: "dc", type: "discord", bot_token_env: "T", access: { mode: "locked", allowed_users: [] } }] },
      instances: { "alpha-t1": { status: "running" } } });
    await mountSettings("agents");
    await type(p.root.querySelector(".s-search input"), "zzz");
    expect(p.root.textContent).toContain("沒有符合「zzz」的 Agent。");
    await type(p.root.querySelector(".s-search input"), "");
    await mountSettings("general");
    await type(p.root.querySelector("#g-auto"), "-1");
    expect(p.root.querySelector(".s-general")!.textContent).toContain("必須為 0 或更大的數值");
    await mountSettings("bots");
    await click(button("設定"));
    confirmAnswer = false;
    await click(button("刪除這個機器人"));     // asked, and a refusal writes nothing
    expect(confirmed.at(-1)).toMatch(/^確定移除機器人「/);
    expect(writes()).toEqual([]);
    expect(confirmed.at(-1)).toMatch(/^確定移除機器人「/);
    w = world({ fleet: null as any });
    await mountSettings("general");
    expect(p.root.textContent).toContain("載入設定失敗 — 請重新開啟 Settings 連結。");
    expect(writes()).toEqual([]);
  });

  it("keeps unsupported provider verifiers fail-closed in the UI", async () => {
    w = world({
      connections: [],
      providerSecrets: [
        { id: "vendor-a", display_name: "Vendor A", verifier: "unsupported", token_present: false },
        { id: "vendor-b", display_name: "Vendor B", verifier: "available", token_present: true },
      ],
    });
    await mountSettings("bots");
    const cards = [...p.root.querySelectorAll("section.card")].filter((s: any) => s.textContent.includes("Provider API keys"));
    expect(cards).toHaveLength(1);
    const [a, b] = [...cards[0]!.querySelectorAll(".s-key")];
    // The unsupported provider: no key input at all, the reason shown instead.
    expect(a!.querySelectorAll("input")).toHaveLength(0);
    expect(a!.textContent).toContain("Unsupported verifier");
    expect(a!.textContent).toContain("no key input is offered");
    // The verifiable one gets its input and verify button.
    expect(b!.querySelectorAll("input[type=password]")).toHaveLength(1);
    expect(buttons("Verify & apply", b)).toHaveLength(1);
  });
});


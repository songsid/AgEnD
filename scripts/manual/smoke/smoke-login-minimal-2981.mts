// #2981 minimal (the user, hmsg-b2832097): what a person reads in Discord and Telegram for `/login claude-code`,
// `/login codex`, `/login muse` and a bare `/login` — every chat message and DM, in order, from the product's own
// LoginController and FleetManager.promptLoginBackends, through mock Discord / Telegram adapters (no network, no bot,
// no CLI: the login terminal is a stand-in that reports what the real pane would show — the provider's URL and code).
// Run it on a checkout before and after the change and diff the transcripts:
//   REPO=<checkout> OUT=<file.json> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-login-minimal-2981.mts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.REPO; if (!REPO) throw new Error("set REPO=<checkout>");
const home = mkdtempSync(join(tmpdir(), "smoke-login-2981-"));
process.env.AGEND_HOME = home;                                     // before anything that logs is imported
const { LoginController } = await import(REPO + "/src/login-controller.ts");
const { LoginWindowLock } = await import(REPO + "/src/login-window-lock.ts");
const { setLocale } = await import(REPO + "/src/locale.ts");
const { FleetManager } = await import(REPO + "/src/fleet-manager.ts");

class StandInSession extends EventEmitter {
  state = "created"; token: string | null = "ABCDEFGHJKMNPQRSTVWX";
  constructor(readonly spec: any, readonly events: any) { super(); }
  async start() { this.state = "running"; }
  peekAccessToken() { return this.token; }
  async cancel(detail = "cancelled") { this.state = "finished"; this.token = null; await this.events.onDone({ ok: false, reason: "cancel", detail }); }
}
class StandInHttp {
  constructor(readonly s: any, readonly o: any) {}
  async listen() { return { port: 40001, url: `http://${this.o.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close() {}
}
/** What the real login pane prints, per backend: the provider's sign-in URL and its code (null: none). */
const PANE: Record<string, [string, string | null]> = {
  "claude-code": ["https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=xyz", null],
  codex: ["https://auth.openai.com/codex/device", "WXYZ-12345"],
};

type Line = { to: "chat" | "dm" | "buttons"; text: string };
function adapter(type: "discord" | "telegram", lines: Line[]) {
  return {
    id: type, type,
    sendText: async (_c: string, text: string) => { lines.push({ to: "chat", text }); return { messageId: `m${lines.length}`, chatId: "chat" }; },
    sendDirect: async (_u: string, text: string) => { lines.push({ to: "dm", text }); return { messageId: `d${lines.length}`, chatId: "u" }; },
    notifyAlert: async (_c: string, alert: any) => {
      lines.push({ to: "buttons", text: `${alert.message ?? alert.text ?? ""}\n${(alert.choices || []).map((c: any) => `[${c.label}]`).join(" ")}` });
      return { messageId: "p", chatId: "chat" };
    },
    editMessageRemoveButtons: async () => {},
  } as any;
}
function controller() {
  const lock = new LoginWindowLock();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  return new LoginController({
    logger: quiet as any,
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example" }) as any,
    isFleetAdmin: () => true,
    eventLog: () => ({ insert: () => {} }),
    recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }),
    postButtons: async () => {},
    claimWindow: (b: string) => lock.tryClaim("web", b),
    releaseWindow: (c: any) => { lock.release(c); },
    isClaimCurrent: (c: any) => lock.isCurrent(c),
    windowBusyMessage: () => lock.busyMessage(),
    checkAuth: async () => "invalid",
    createSession: (spec: any, ev: any) => { const s = new StandInSession(spec, ev); sessions.push(s); return s as any; },
    createHttp: (s: any, _l: any, o: any) => new StandInHttp(s, o) as any,
  } as any);
}
const sessions: StandInSession[] = [];
const out: Record<string, Line[]> = {};

for (const lang of ["en", "zh-TW"] as const) {
  setLocale(lang);
  for (const platform of ["discord", "telegram"] as const) {
    for (const backend of ["claude-code", "codex", "muse"]) {
      const lines: Line[] = [], a = adapter(platform, lines), c = controller();
      sessions.length = 0;
      const chat = { adapter: a, adapterId: platform, chatId: "chat", threadId: "topic", userId: "admin-1" };
      const reply = await c.start(backend, chat, { skipAuthCheck: true });     // the person pressed "I understand, open"
      if (reply) lines.push({ to: "chat", text: reply });
      const s = sessions[0];
      if (s && PANE[backend]) await s.events.onHint(...PANE[backend]);         // the pane shows the provider's URL/code
      if (s) await c.cancel();
      out[`${lang} ${platform} /login ${backend}`] = lines;
    }
    // A bare /login on a host with these CLIs installed.
    const lines: Line[] = [], a = adapter(platform, lines);
    const fm: any = new FleetManager(home);
    fm.fleetConfig = { defaults: {}, instances: {}, fleet_label: "demo-fleet" };   // a neutral label, never this host's name
    fm.isCliInstalled = () => true; fm.isCliInstalledOffLoop = async () => true;
    fm.probeInstalledBackends = () => new Set(["antigravity", "claude-code", "codex", "muse", "opencode"]);
    const failure = await fm.promptLoginBackends({ adapter: a, adapterId: platform, chatId: "chat", threadId: "topic" });
    if (failure) lines.push({ to: "chat", text: failure });
    out[`${lang} ${platform} /login`] = lines;
  }
}
setLocale("en");
const file = process.env.OUT ?? join(tmpdir(), "smoke-login-2981.json");
writeFileSync(file, JSON.stringify(out, null, 2));
for (const [k, lines] of Object.entries(out)) {
  console.log(`\n=== ${k}`);
  for (const l of lines) console.log(`  [${l.to}] ${l.text.replace(/\n/g, "\n         ")}`);
}
rmSync(home, { recursive: true, force: true });
process.exit(0);

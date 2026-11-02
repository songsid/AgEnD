// #2940 acceptance (fleet level, no network): a ClassicBot room shared by three bots of one fleet — alpha, beta, gamma —
// each a REAL DiscordAdapter (discord.js client, AgEnD's own event handlers) wired to the REAL FleetManager collab path,
// writing the REAL chat-log files under a scratch AGEND_HOME. Only the socket is replaced: the gateway's events are emitted
// on each bot's client (messageCreate / messageDelete), and beta's status-bubble post (notifyAlert) is answered here.
// Steps (the leader's list):
//   1. beta posts its "👀 處理中…" bubble: alpha and gamma see it (messageCreate) — AFTER beta's post is answered;
//   2. the race: beta's next bubble reaches alpha/gamma BEFORE its post is answered;
//   3. a person writes 「處理中」 (kept), beta replies for real (kept), gamma replies for real (kept);
//   4. a person's message is deleted after it was logged (messageDelete) — taken out of every bot's log;
//   5. beta deletes its bubbles (as AgEnD does once the reply lands) — nothing left to remove;
//   6. a person @mentions alpha: the [Chat log for context] alpha's agent gets (context_lines 5) has 5 real lines.
// Prints the transcript (each step, both logs, the context block). Exit 0 = PASS.
//   AGEND_HOME is set to a scratch dir by this script. npx tsx scripts/manual/classic-2940/acceptance.mts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "agend-2940-acc-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../../../src/fleet-manager.js");
const { DiscordAdapter } = await import("../../../src/channel/adapters/discord.js");
const { AccessManager } = await import("../../../src/channel/access-manager.js");
const { ClassicChannelManager } = await import("../../../src/classic-channel-manager.js");

const out: string[] = [], checks: Array<[string, boolean, string]> = [];
const say = (s: string) => { out.push(s); };
const check = (name: string, ok: boolean, detail = "") => { checks.push([name, ok, detail]); };
const tick = () => new Promise(r => setTimeout(r, 20));
class Coll<V> extends Map<string, V> { map<R>(fn: (v: V) => R): R[] { return [...this.values()].map(fn); } }

const GUILD = "guild-1", ROOM = "room-1", OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };
const BOTS = { alpha: "bot-alpha", beta: "bot-beta", gamma: "bot-gamma" } as const;
const fm: any = new FleetManager(home);
fm.logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return fm.logger; } };
const adapters: Record<string, any> = {};
const channels = Object.keys(BOTS).map(id => ({ id, type: "discord", mode: "topic", group_id: GUILD, access: OPEN }));
fm.fleetConfig = { defaults: {}, channels, instances: {} };
for (const [id, botId] of Object.entries(BOTS)) {
  const a = new DiscordAdapter({ id, botToken: "FAKE-TOKEN-FOR-ACCEPTANCE", accessManager: new AccessManager(OPEN, join(home, `${id}.json`)), inboxDir: join(home, "inbox"), guildId: GUILD, registerCommands: false });
  Object.defineProperty(a.client, "user", { value: { id: botId }, configurable: true });
  adapters[id] = a;
  fm.worlds.set(id, { id, adapter: a, channelConfig: channels.find(c => c.id === id), groupId: GUILD, botUserId: botId, accessManager: new AccessManager(OPEN, join(home, `${id}-w.json`)) });
  fm.adapters.set(id, a);
  // The production wiring (FleetManager's adapter setup): messages to the shared handler; deletes to the chat-log backstop.
  a.on("message", (m: unknown) => void fm.handleInboundMessage(m));
  a.on("message_deleted", (e: { messageId?: string }) => fm.onPlatformMessageDeleted?.(e?.messageId));   // (main before #2940: none)
}
fm.adapter = adapters.alpha;
const classic = new ClassicChannelManager(home, fm.logger);
classic.setPrimaryAdapterId("alpha");
for (const id of Object.keys(BOTS)) { classic.register(ROOM, id, id, "room", "owner"); classic.toggleCollab(ROOM, id); }
fm.classicChannels = classic;
fm.routing.rebuild(fm.fleetConfig);
// An agent's delivery is captured, not sent (no CLI runs): what alpha's agent would read.
const delivered: Array<{ name: string; text: string }> = [];
fm.deliverToInstance = async (name: string, payload: any) => { delivered.push({ name, text: String(payload?.content ?? payload?.text ?? JSON.stringify(payload)) }); };
fm.getInstanceStatus = () => "running";
fm.lifecycle.isPaused = () => false;
fm.sendCancelButton = fm.sendCancelButton.bind(fm);

let seq = 0;
const message = (author: { id: string; bot: boolean; username: string }, content: string, id = `m-${++seq}`) => ({
  author, guildId: GUILD, channelId: ROOM, id, content, attachments: new Coll<any>(), embeds: [] as any[], reference: undefined, createdAt: new Date(),
  mentions: { users: new Coll<any>(), has: (u: any) => content.includes(`<@${typeof u === "string" ? u : u?.id}>`) }, channel: { id: ROOM, isThread: () => false },
  member: { displayName: author.username }, type: 0,
});
/** The gateway: a message from `fromBot` (or a person) reaches every OTHER bot's client (a bot never sees its own). */
async function gateway(msg: any, fromBot?: string) {
  for (const [id, a] of Object.entries(adapters)) if (id !== fromBot) (a as any).client.emit("messageCreate", msg);
  await tick();
}
async function deleted(id: string) { for (const a of Object.values(adapters)) (a as any).client.emit("messageDelete", { id, channelId: ROOM, partial: true }); await tick(); }
const logOf = (instance: string) => { const d = ClassicChannelManager.chatLogDir(instance); try { return readdirSync(d).map(f => readFileSync(join(d, f), "utf8")).join(""); } catch { return ""; } };
const BETA = { id: BOTS.beta, bot: true, username: "BetaBot" }, GAMMA = { id: BOTS.gamma, bot: true, username: "GammaBot" }, ANN = { id: "user-ann", bot: false, username: "ann" };

/** beta posts its status bubble: the post goes out (the gateway delivers it to the others), and is answered with its id. */
async function bubble(text: string, answerFirst: boolean) {
  const id = `bubble-${++seq}`;
  let answer!: () => void;
  adapters.beta.notifyAlert = () => new Promise(resolve => { answer = () => resolve({ messageId: id, chatId: GUILD, threadId: ROOM }); });
  const posting = fm.sendCancelButton("beta");
  await tick();
  if (answerFirst) { answer(); await posting; await gateway(message(BETA, text, id), "beta"); }
  else { await gateway(message(BETA, text, id), "beta"); say(`   (alpha/gamma saw ${id} before beta's post was answered: alpha's log has it now: ${logOf("alpha").includes(text)})`); answer(); await posting; }
  return id;
}

say("1. beta posts \"👀 處理中…\" (its post answered first, then the gateway delivers it to alpha and gamma)");
const b1 = await bubble("👀 處理中…", true);
say("2. beta posts \"⚡ 處理中…\" — the race: alpha and gamma get it BEFORE beta's post is answered");
const b2 = await bubble("⚡ 處理中…", false);
say("3. ann writes 「處理中」 herself; beta and gamma reply for real");
await gateway(message(ANN, "我這邊還在處理中，等我一下"));
await gateway(message(BETA, "Deployed build 4812 to staging."), "beta");
await gateway(message(GAMMA, "Smoke tests on staging: 42/42 passed."), "gamma");
say("4. ann posts a line, it is logged, then she deletes it (messageDelete reaches every bot)");
const oops = message(ANN, "oops, wrong channel — ignore this");
await gateway(oops);
const loggedBefore = logOf("alpha").includes("oops, wrong channel");
await deleted(oops.id);
say("5. beta deletes its bubbles once its reply landed (as AgEnD does)");
await deleted(b1); await deleted(b2);
await gateway(message(ANN, "beta, can you also bump the version?"));
await gateway(message(GAMMA, "I'll update the changelog."), "gamma");
say("6. ann @mentions alpha: alpha's agent gets the [Chat log for context] (context_lines 5)");
await gateway(message(ANN, `<@${BOTS.alpha}> what's the status of the release?`));
await tick();

for (const room of ["alpha", "gamma"]) {
  const log = logOf(room);
  check(`${room}'s log has no status bubble (neither the answered one nor the race)`, !log.includes("👀 處理中…") && !log.includes("⚡ 處理中…"), "");
  // (a bot never receives its own messages: gamma's own replies are logged when it sends them, not from the gateway)
  const others = room === "alpha" ? ["Deployed build 4812", "Smoke tests on staging"] : ["Deployed build 4812"];
  check(`${room}'s log keeps ann's 「處理中」 and the other bots' real replies`, log.includes("我這邊還在處理中") && others.every(t => log.includes(t)), "");
  check(`${room}'s log no longer has ann's deleted line`, !log.includes("oops, wrong channel"), "");
}
check("the deleted line had been logged before its delete (so the delete took it out)", loggedBefore, "");
const forward = delivered.find(d => d.name === "alpha");
const block = forward ? (/\[Chat log for context\]\n([\s\S]*?)\n\n\[User message\]/.exec(forward.text)?.[1] ?? "") : "";
const lines = block.split("\n").filter(l => /^\[[^\]]+\] </.test(l));
check("alpha's context block: 5 real lines, none a status bubble", lines.length === 5 && !/處理中…/.test(block), `${lines.length} lines`);

say("\n── alpha's chat-logs file ──\n" + logOf("alpha").trimEnd());
say("\n── gamma's chat-logs file ──\n" + logOf("gamma").trimEnd());
say("\n── what alpha's agent received ──\n" + (forward?.text ?? "(nothing delivered)"));
say("\n| check | result |\n|---|---|\n" + checks.map(([n, ok]) => `| ${n} | ${ok ? "PASS" : "FAIL"} |`).join("\n"));
const pass = checks.every(([, ok]) => ok);
say(`\nRESULT ${pass ? "PASS" : "FAIL"}`);
console.log(out.join("\n"));
for (const a of Object.values(adapters)) await (a as any).stop().catch(() => {});
rmSync(home, { recursive: true, force: true });
process.exit(pass ? 0 : 1);

/**
 * M-3770 slice 1.5 evidence: the update card in General's chat, from the REAL FleetManager (owned web fixture; no Fleet/CLI
 * starts, no chat platform, nothing installed). A chat platform's message can't be captured from the web (the card is a
 * platform prompt, not mirrored to the dashboard), so this records exactly what the chat adapter is handed — the card's
 * text and buttons, each edit, each private reply — through the real post/press paths, in en and zh-TW:
 *   offer posted once · a non-admin's press (told privately, buttons stay) · Update when idle (edited in place) ·
 *   cancel from the web (edited: cancelled) and the offer again · a newer version (old one replaced) · Tonight · Not now ·
 *   and that the daily check no longer posts "Run: /update".
 *   PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-chat-card-s240/transcript.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const { setLocale } = await import(REPO + "/src/locale.ts");
const lines: string[] = [`# M-3770 1.5: General's update card — what the chat adapter receives`, ``, `Source \`${receipt.sourceHead}\` (src clean: ${receipt.dirty.length === 0}). Real FleetManager; a recording adapter in place of Discord/Telegram.`, ``];

for (const lang of ["en", "zh-TW"] as const) {
  setLocale(lang === "en" ? "en" : "zh-TW");
  const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
    { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
    { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
  ] });
  const fm: any = fx.fm;
  const log: string[] = [];
  const say = (s: string) => { log.push(s); };
  const adapter = {
    notifyAlert: async (_chat: string, alert: any) => { say(`**posted** — ${JSON.stringify(alert.message)}\n  buttons: ${alert.choices.map((c: any) => `[${c.label}]`).join(" ")}`); return { chatId: "-100", threadId: "7", messageId: `m${log.length}` }; },
    editMessage: async (_c: string, m: string, text: string) => { say(`**edited** ${m} — ${JSON.stringify(text)}`); },
    editMessageRemoveButtons: async (_c: string, m: string, text: string) => { say(`**edited, buttons removed** ${m} — ${JSON.stringify(text)}`); },
  };
  try {
    fm.webOnlyPromptPlace = () => null;
    fm.findGeneralInstance = () => "general";
    fm.getInstanceAdapterId = () => "tg";
    fm.getAdapterForInstance = () => adapter;
    fm.getGroupIdForInstance = () => "-100";
    fm.fleetAdminGate = (userId: string) => (userId === "1" ? "ok" : "denied");
    fm.hubUpdateIdle = () => false;                                            // agents at work: an answer waits
    fm.launchInstalledUpdate = async () => { throw new Error("must not launch"); };
    fm.startWebUpdate = async () => ({ ok: false, status: 503, error: "capture" });
    fm.updatePreflight = { class: "self", checkedAt: Date.now(), pressHere: true, checks: [{ id: "P3", ok: true }] };
    const posts: string[] = [];
    fm.notifyInstanceTopic = (_n: string, text: string) => { posts.push(text); say(`**topic post** — ${JSON.stringify(text)}`); return true; };
    const cur = fm.runningAgendVersion(), next = cur.replace(/(\d+)$/, (n: string) => String(Number(n) + 1)), next2 = cur.replace(/(\d+)$/, (n: string) => String(Number(n) + 2));
    fm.lookUpUpdateTarget = async () => ({ target: next, fromChannel: true });
    const lastId = () => [...fm.pendingNonceButtons.entries()].filter(([, e]: any) => e.prefix === "update-card:").map(([k]: any) => k).at(-1);
    const press = async (action: string, userId = "1") => {
      const nonce = lastId(), entry: any = fm.pendingNonceButtons.get(nonce);
      const ack = (t?: string) => t && say(`**private reply to ${userId === "1" ? "the admin" : "a non-admin"}** — ${JSON.stringify(t)}`);
      say(`_press [${action}] by ${userId === "1" ? "a fleet admin" : "a non-admin"}_`);
      return fm.handleUpdateCardCallback({ callbackData: `update-card:${nonce}:${action}`, userId, username: userId === "1" ? "Example owner" : "someone", chatId: entry?.chatId ?? "-100", threadId: entry?.threadId, messageId: entry?.messageId ?? "m1", ack }, "tg", adapter);
    };
    say(`### ${lang}`);
    say(`_the daily check, twice_`);
    await fm.checkForUpdates(); await fm.checkForUpdates(); await fm.syncUpdateChatCard();
    check(`${lang}: one card posted, no "Run: /update" post`, log.filter((l) => l.startsWith("**posted**")).length === 1 && posts.length === 0, log);
    await press("when-idle", "9");
    check(`${lang}: a non-admin is told privately; the card stays offered`, fm.updateOfferView().state === "offered" && log.some((l) => l.startsWith("**private reply to a non-admin**")), log.slice(-2));
    await press("when-idle");
    check(`${lang}: Update when idle → waiting, edited in place`, fm.updateOfferView().state === "waiting-idle" && log.at(-1)!.startsWith("**edited"), log.at(-1));
    say(`_cancel from the web_`);
    await fm.ensureUpdateCard().answer(`web-${lang}`, "Example owner", { action: "cancel" }); await fm.syncUpdateChatCard();
    check(`${lang}: the old message says cancelled; a fresh card is posted`, log.filter((l) => l.startsWith("**posted**")).length === 2, log.slice(-3));
    say(`_a newer version arrives_`);
    fm.lookUpUpdateTarget = async () => ({ target: next2, fromChannel: true });
    await fm.checkForUpdates(); await fm.syncUpdateChatCard();
    check(`${lang}: a newer version replaces the card`, log.filter((l) => l.startsWith("**posted**")).length === 3, log.slice(-3));
    await press("tonight");
    const v = fm.updateOfferView();
    check(`${lang}: Tonight → scheduled at 22:00`, v.state === "scheduled" && new Date(v.scheduledAt).getHours() === 22, v);
    await fm.ensureUpdateCard().answer(`web2-${lang}`, "Example owner", { action: "cancel" }); await fm.syncUpdateChatCard();
    await press("not-now");
    check(`${lang}: Not now`, fm.updateOfferView().state === "not-now", fm.updateOfferView());
  } finally { try { fm.updateCard?.close(); } catch { /* closed */ } await fx.close(); }
  lines.push(...log, ``);
}
lines.push(`Checks: ${receipt.checks.filter((c: any) => c.ok).length}/${receipt.checks.length}.`);
writeFileSync(join(OUT, "transcript.md"), lines.join("\n") + "\n");
const failed = receipt.checks.filter((x: any) => !x.ok).length;
receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(`checks ${receipt.summary}`);
process.exitCode = failed ? 1 : 0;

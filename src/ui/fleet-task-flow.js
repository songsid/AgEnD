// Who has the baton on a main task (Fleet › Tasks › a card; docs/design/task-board.md, "Live state and handoffs"). A main task follows its
// sub tasks, so its own status says little: "In progress" is a status, not a sign that an agent is working. This page's pieces say what is
// really happening, one line per sub task, in the person's words (`subLine`: the whole sentence, and a short label for the sub tasks' rows):
//   · a sub task its assignee is working on: what it is doing now — "dev · Edit src/game.js" (the chat's own activity feed, `tool_progress`,
//     an admin only) or, without steps, the state alone — "dev · Running". In the sub tasks' list the row itself says it: its title shimmers
//     (still with reduced motion) and the sentence is the row's tooltip; the steps are the main task's "Agent activity" block's to show;
//   · one waiting for another: "Waits for S-1" — then, when S-1 is done, the baton: "Handed to dev" → "dev read it" → running;
//   · one that cannot go on: blocked, the assignee waiting for the person, looking stuck, idle, offline or paused, or the hand-over that did
//     not arrive (the task board is off, the notice was lost).
// The same lines summarise the main task's "Agent activity" block (the whole sentence), the other states are a short label in the sub task's own
// row (no second line), and a handoff is a row of the main task's activity ("S-1 done → handed to dev to start S-2" and how far it got).
//
// Nothing here is stored by the page. The state is the same inference as the card's "Running" (`runOf`, fleet-task-run.js — an agent is one
// continuing session, so "working" says it is busy, not that it is on this very card); the hand-over's delivery is what the card read carries
// (`handoffs`, only for a session that can write, never of an instance kept out of sight); the steps are the chat's own feed, held only while
// a sub task is running and the viewer is an admin whose agent has `tool_progress` on — otherwise the state alone. No style attribute (the CSP).
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { activityDrawCtx, activityOffered, activityPrefs, activitySnapshot, observeActivity } from "./chat-activity.js";
import { stepLine } from "./log-row.js";
import { StatusPill, relTime, waitsList, waitsOn } from "./fleet-task-common.js";
import { instanceStates, liveGroupOf, runOf, runUnclaimed } from "./fleet-task-run.js";

register("taskflow", {
  en: {
    running: "Running", needs: "waiting for you", stuck: "looks stuck", idle: "idle", busyN: "busy with {0} cards", busyTip: "{0} has {1} cards in progress, so what it is doing now may belong to another of them",
    runningTip: "From {0}'s state: an agent is one continuing session, so it may be busy with something else",
    waitsFor: "Waits for {0}", readyNobody: "Ready to start — nobody is assigned", readyFor: "Ready — {0} has not started it yet", blocked: "Blocked", blockedOn: "Blocked: {0}",
    sending: "Handed to {0}", queued: "Waiting for {0} to take it", offline: "{0} is offline — it gets this when it is back", paused: "{0} is paused — it gets this when it is resumed",
    delivered: "Delivered to {0} — waiting for it to start", read: "{0} read it — waiting for it to start",
    unclaimed: "not claimed yet", unclaimedLate: "still not claimed", unclaimedTip: "{0} is working and this is the card it was given, but it has not moved it to In progress (claimed it): what it is doing now is probably this card.",
    unclaimedLateTip: "{0} has been working for a while without claiming this card. Ask it to claim it (task claim), or move the card to In progress yourself — the board never moves it for an agent.",
    failed: "Could not hand it to {0}", uncertain: "Not sure {0} got it", withdrawn: "The notice to {0} was withdrawn: the card changed again, and {0} hears its new state",
    "skip.board_off": "{0}'s task board is off, so it was not told", "skip.not_taken": "The notice to {0} could not be queued", "skip.lost": "The notice to {0} was lost (AgEnD restarted before it was sent)",
    "skip.other": "{0} was not told",
    handedAfter: "{0} done → handed to {1} to start {2}", handedReady: "{2} can start → handed to {1}", handedAssigned: "{2} handed to {1}", started: "{0} started {1}", startedNeutral: "{0} started",
    handoffLabel: "A sub task handed on", linesLabel: "What the sub tasks are doing", openCard: "Open {0}", more: "+{0} more", tipWorking: "{0} · {1}",
    chipWaits: "Waits for {0}", chipReady: "Ready", chipBlocked: "Blocked", chipNeeds: "Waiting for you", chipStuck: "Looks stuck", chipIdle: "Idle", chipBusy: "Busy · {0} cards",
    chipSending: "Handed to {0}", chipQueued: "Waiting", chipOffline: "{0} offline", chipPaused: "{0} paused", chipDelivered: "Delivered", chipRead: "Read",
    chipFailed: "Not sent", chipUncertain: "Not sure it arrived", chipWithdrawn: "Withdrawn", chipNotTold: "Not told", chipUnclaimed: "Not claimed yet", chipUnclaimedLate: "Still not claimed",
  },
  "zh-TW": {
    running: "執行中", needs: "等你回應", stuck: "似乎卡住", idle: "閒置", busyN: "忙碌中（{0} 張卡）", busyTip: "{0} 同時有 {1} 張卡在進行中，目前的動作可能屬於其中另一張",
    runningTip: "由 {0} 目前的狀態推論：Agent 只有一個連續的對話，可能在處理別的事",
    waitsFor: "等 {0}", readyNobody: "可以開始，但還沒有人負責", readyFor: "可以開始，等 {0} 接手", blocked: "卡住了", blockedOn: "卡住：{0}",
    sending: "已交給 {0}", queued: "等 {0} 接手", offline: "{0} 離線，上線後就會收到", paused: "{0} 已暫停，恢復後就會收到",
    delivered: "已送達 {0}，等它開始", read: "{0} 已讀，等它開始",
    unclaimed: "尚未認領", unclaimedLate: "還是沒有認領", unclaimedTip: "{0} 正在執行，而這是交給它的卡，但它還沒有把卡片移到進行中（沒有認領）：它現在做的很可能就是這張。",
    unclaimedLateTip: "{0} 已經做了一陣子，卻還沒認領這張卡。請它認領（task claim），或你自己把卡片移到進行中——系統不會替 agent 改狀態。",
    failed: "沒有送達 {0}", uncertain: "無法確認 {0} 是否收到", withdrawn: "給 {0} 的通知已撤回：卡片又有變動，{0} 會從新的通知得知最新狀態",
    "skip.board_off": "{0} 的任務板是關閉的，沒有通知它", "skip.not_taken": "給 {0} 的通知沒能排入傳送", "skip.lost": "給 {0} 的通知遺失了（送出前 AgEnD 重新啟動）",
    "skip.other": "沒有通知 {0}",
    handedAfter: "{0} 完成 → 已交給 {1} 開始 {2}", handedReady: "{2} 可以開始 → 已交給 {1}", handedAssigned: "已把 {2} 交給 {1}", started: "{0} 已開始 {1}", startedNeutral: "{0} 已開始",
    handoffLabel: "子任務的交接", linesLabel: "各子任務目前的狀況", openCard: "開啟 {0}", more: "還有 {0} 項", tipWorking: "{0} · {1}",
    chipWaits: "等 {0}", chipReady: "可以開始", chipBlocked: "卡住了", chipNeeds: "等你回應", chipStuck: "似乎卡住", chipIdle: "閒置", chipBusy: "忙碌中（{0} 張）",
    chipSending: "已交給 {0}", chipQueued: "等它接手", chipOffline: "{0} 離線", chipPaused: "{0} 已暫停", chipDelivered: "已送達", chipRead: "已讀",
    chipFailed: "沒送達", chipUncertain: "不確定是否送達", chipWithdrawn: "已撤回", chipNotTold: "沒通知到", chipUnclaimed: "尚未認領", chipUnclaimedLate: "還是沒認領",
  },
});

// ── What a line says (pure: tests import these) ───────────

/** The strongest first, for the main task's summary: working, then what needs a person, then what was handed on, then what is quiet. */
export const LINE_RANK = { running: 0, needs: 1, stuck: 2, busy: 3, blocked: 4, handed: 5, idle: 6, ready: 7, waiting: 8 };
/** The notices that are still on their way: the page reads the card again soon while any is. */
const MOVING = ["sending", "queued", "delivered"];
/** The reasons a hand-over was not sent that have words of their own; the rest read "{0} was not told". */
const SKIP_WORDS = new Set(["board_off", "not_taken", "lost"]);

/** A card's newest handoff to its current assignee (the page's `handoffs`), or null — an older one to someone else is not the baton now. */
export function latestHandoff(handoffs, card) {
  let found = null;
  for (const h of handoffs || []) if (h && h.card === card.id && h.to === card.assignee && (!found || h.id > found.id)) found = h;
  return found;
}

/** The notice has been taken (or nothing is known of it), so a working instance may be on the card; one still on its way, failed or held back has not got it. */
export function handoffAllows(h) {
  return !h || h.state === "delivered" || h.state === "read" || h.state === "unknown" || (h.state === "skipped" && h.skip === "not_waiting");
}

/** An instance that has been working this long on a card it has not claimed is flagged: asked to claim, or the person moves it. */
export const UNCLAIMED_GRACE_MS = 90_000;
/** While a "not claimed yet" line is on the page it is looked at again this often, so it turns into the flagged one without waiting for the store to change. */
export const CLOCK_MS = 30_000;

/** Redraws the caller every `ms` while `on` — no timer at all otherwise. */
function useClock(on, ms = CLOCK_MS) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const handle = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(handle);
  }, [on, ms]);
}
/** Whether a line says "not claimed yet" and may still turn into the flagged one. */
const turning = (line) => !!line && line.kind === "running" && !!line.unclaimed && !line.late;

/**
 * A handoff in words: `{ tone, text, chip, tip? }`, or null when there is nothing to say (the card no longer waited on it, the delivery has no
 * record any more). `chip`: the short label of the sub tasks' rows. `tone`: `wait` (on its way), `ok` (taken), `busy` (its instance is working), `bad` (not sent), `muted` (withdrawn).
 * `states`: the instances' dot states by name (`instanceStates`): offline and paused are the page's inference, as under a comment.
 */
export function handoffText(h, states) {
  if (!h) return null;
  const to = h.to;
  const state = states && states.get ? states.get(to) : undefined;
  switch (h.state) {
    case "skipped": return h.skip === "not_waiting" ? null : { tone: "bad", text: t(`taskflow.skip.${SKIP_WORDS.has(h.skip) ? h.skip : "other"}`, to), chip: t("taskflow.chipNotTold") };
    case "failed": return { tone: "bad", text: t("taskflow.failed", to), chip: t("taskflow.chipFailed") };
    case "uncertain": return { tone: "bad", text: t("taskflow.uncertain", to), chip: t("taskflow.chipUncertain") };
    case "withdrawn": return { tone: "muted", text: t("taskflow.withdrawn", to), chip: t("taskflow.chipWithdrawn") };
    case "sending": return { tone: "wait", text: t("taskflow.sending", to), chip: t("taskflow.chipSending", to) };
    case "queued": {
      const off = state === "stopped" || state === "crashed", paused = state === "paused";
      return { tone: "wait", text: t(off ? "taskflow.offline" : paused ? "taskflow.paused" : "taskflow.queued", to), chip: off ? t("taskflow.chipOffline", to) : paused ? t("taskflow.chipPaused", to) : t("taskflow.chipQueued") };
    }
    // (An instance that is working is not "working on this card" here: when it probably is, the card says so as a running line — `subLine`,
    // `runUnclaimed` — and when it cannot be known, the notice's own state is all that is said: never "working" beside "not started".)
    case "delivered": case "read": return { tone: "ok", text: t(h.state === "read" ? "taskflow.read" : "taskflow.delivered", to), chip: t(h.state === "read" ? "taskflow.chipRead" : "taskflow.chipDelivered") };
    default: return null;
  }
}

/**
 * What a sub task says, or null: `{ kind, tone, text, chip?, tip?, spin?, who }` — see this file's head. `text` is the whole sentence (the main task's block lists it, the
 * row's tooltip starts with it); `chip` the short label of the row (none for a sub task that is running: its title shimmers); `tip` explains. `ctx`: { handoffs, states, doing, live(name) → the step line }.
 */
export function subLine(card, ctx) {
  const who = card.assignee || "";
  if (card.status === "claimed") {
    const run = who ? runOf(card, { states: ctx.states, doing: ctx.doing }) : null;
    if (!run) return null;
    if (run.state === "working" && run.shared) { const text = `${who} · ${t("taskflow.busyN", run.shared)}`; return { kind: "busy", tone: "muted", who, text, chip: t("taskflow.chipBusy", run.shared), tip: `${text}\n${t("taskflow.busyTip", who, run.shared)}` }; }
    if (run.state === "working") {
      const doing = (ctx.live && ctx.live(who)) || "";
      const text = `${who} · ${doing || t("taskflow.running")}`;
      return { kind: "running", tone: "busy", who, spin: true, text, tip: `${text}\n${t("taskflow.runningTip", who)}` };
    }
    if (run.state === "needs") return { kind: "needs", tone: "warn", who, text: `${who} · ${t("taskflow.needs")}`, chip: t("taskflow.chipNeeds") };
    if (run.state === "stuck") return { kind: "stuck", tone: "bad", who, text: `${who} · ${t("taskflow.stuck")}`, chip: t("taskflow.chipStuck") };
    return { kind: "idle", tone: "muted", who, text: `${who} · ${t("taskflow.idle")}`, chip: t("taskflow.chipIdle") };
  }
  if (card.status === "blocked") return { kind: "blocked", tone: "bad", who, text: card.blockedReason ? t("taskflow.blockedOn", card.blockedReason) : t("taskflow.blocked"), chip: t("taskflow.chipBlocked") };
  if (card.status !== "open") return null;
  if (waitsOn(card)) { const list = waitsList(card, ", "); return { kind: "waiting", tone: "wait", who, text: t("taskflow.waitsFor", list), chip: t("taskflow.chipWaits", list) }; }
  if (!who) return { kind: "ready", tone: "wait", who, text: t("taskflow.readyNobody"), chip: t("taskflow.chipReady") };
  const latest = latestHandoff(ctx.handoffs, card);
  // The card is still open, but its assignee is working and probably on it (it was given the card, can start, has nothing in progress): it did not
  // claim it. A running line, with the step, marked "not claimed" — and flagged once it has gone on a while.
  if (handoffAllows(latest) && runUnclaimed(card, ctx)) {
    const doing = (ctx.live && ctx.live(who)) || "";
    const since = Math.max(Date.parse(latest && latest.at) || 0, Date.parse(card.handedAt) || 0, Date.parse(card.updatedAt) || 0);
    const late = since > 0 && (ctx.now || Date.now()) - since > UNCLAIMED_GRACE_MS;
    const text = `${who} · ${doing || t("taskflow.running")} (${t(late ? "taskflow.unclaimedLate" : "taskflow.unclaimed")})`;
    return { kind: "running", tone: late ? "warn" : "busy", who, spin: true, unclaimed: true, late, text, chip: t(late ? "taskflow.chipUnclaimedLate" : "taskflow.chipUnclaimed"),
      tip: `${text}\n${t(late ? "taskflow.unclaimedLateTip" : "taskflow.unclaimedTip", who)}` };
  }
  const said = handoffText(latest, ctx.states);
  return said ? { kind: "handed", who, ...said } : { kind: "ready", tone: "wait", who, text: t("taskflow.readyFor", who), chip: t("taskflow.chipReady") };
}

/** What the main task's block lists: a sub task someone is on, something that needs a person, a hand-over on its way or failed. A sub task that only waits, or is ready with no record of a hand-over, is the list's row, not the block's. */
const SUMMARISED = new Set(["running", "needs", "stuck", "busy", "blocked", "handed", "idle"]);

/**
 * The lines the main task's "Agent activity" block says: what its sub tasks are doing, the strongest first (running, waiting for you, stuck,
 * busy, blocked, handed on, idle). At most `max`, and how many more there were. `{ lines: [{ card, line }], more }`; no line when nothing is going on
 * (every sub task done, cancelled, waiting, or ready with nobody told) — the block is then its one quiet line.
 */
export function mainLines(subs, ctx, max = 4) {
  const all = [];
  for (const card of subs || []) {
    if (card.status === "cancelled" || card.status === "done") continue;
    const line = subLine(card, ctx);
    if (line && SUMMARISED.has(line.kind)) all.push({ card, line });
  }
  const pick = all.map((x, i) => ({ ...x, i })).sort((a, b) => LINE_RANK[a.line.kind] - LINE_RANK[b.line.kind] || a.i - b.i);
  return { lines: pick.slice(0, max).map(({ card, line }) => ({ card, line })), more: Math.max(0, pick.length - max) };
}

/**
 * How a handoff was followed by its card starting: the card's move to in progress at or after it (a sub task's, from the main task's sub events; its own,
 * from its history) — `{ at, by }`, `by` the one who moved it (the instance it was handed to, or someone else) — or null.
 */
export function startedAfter(h, detail) {
  const at = Date.parse(h.at) || 0;
  const moves = [];
  for (const e of (detail && detail.subEvents) || []) if (e.card === h.card) moves.push({ at: e.at, by: e.actor, to: e.data && e.data.to });
  if (detail && detail.card && detail.card.id === h.card) for (const e of detail.history || []) if (e.type === "moved") moves.push({ at: e.at, by: e.actor, to: e.data && e.data.to });
  const hit = moves.filter((m) => m.to === "claimed" && (Date.parse(m.at) || 0) >= at - 1000).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))[0];
  return hit ? { at: hit.at, by: hit.by || "" } : null;
}

/**
 * A handoff as the activity stream says it (pure: tests import it): the sentence — "S-1 done → handed to dev to start S-2" — and, under it,
 * where it stands: the card started (`done`) — "dev started S-2", or just "S-2 started" when someone other than the instance it was handed to moved it
 * (a person, another instance: the page does not say the baton-holder did what it did not) — or what `handoffText` says. `started`: `startedAfter`'s.
 */
export function batonOf(h, states, started) {
  const lead = h.why === "assigned" ? t("taskflow.handedAssigned", "", h.to, h.card)
    : h.after ? t("taskflow.handedAfter", h.after, h.to, h.card) : t("taskflow.handedReady", "", h.to, h.card);
  const said = handoffText(h, states);            // (its short label is the sub tasks' rows': not here)
  const status = started ? { tone: "done", text: started.by === h.to ? t("taskflow.started", h.to, h.card) : t("taskflow.startedNeutral", h.card) } : said && { tone: said.tone, text: said.text, ...(said.tip ? { tip: said.tip } : {}) };
  return { lead, status };
}

/** Whether any handoff has a notice still on its way, so that the page reads the card again soon (see `wakesMoving`). */
export function handoffsMoving(detail, now = Date.now()) {
  for (const h of (detail && detail.handoffs) || []) if (MOVING.includes(h.state) && now - (Date.parse(h.at) || 0) <= 3 * 60_000) return true;
  return false;
}

/** The instances a card's handoffs were made to, for the page to read their states of. */
export const handoffNames = (detail) => [...new Set(((detail && detail.handoffs) || []).map((h) => h.to))];

// ── The steps of the sub tasks that are running ───────────

/** Bumped when a feed read something: what draws a step line redraws (the card page itself does not). */
export const liveFeeds = createStore({ n: 0 });

/**
 * The line "what it is doing now" of an instance, from the steps the chat's feed holds (`observeActivity`): the newest step the way the chat's
 * activity block says it ("Edit src/game.js"), or the backend's own phase ("Reasoning…") when no call is running. Empty — the state alone — when
 * there is nothing to draw from: not an admin, the agent's tool_progress is off, its backend offers no steps, or nothing was written yet.
 */
export function liveLineOf(name) {
  const snap = activitySnapshot(name);
  const group = snap ? liveGroupOf(snap, { since: 0, busy: true }) : null;
  if (!group) return "";
  const draw = activityDrawCtx(name);
  const items = group.items.filter((s) => draw.thinking || s.kind !== "thinking");
  const last = items[items.length - 1];
  const callRunning = !!last && last.kind === "tool" && last.status === "running";
  if (group.phase && !callRunning) { const key = `act.ph_${group.phase}`; const word = t(key); if (word !== key) return word; }
  return last ? stepLine(last, draw.paths) : "";
}

/** Holds the feeds of these instances while they are running a sub task and the viewer may see steps; says nothing itself. */
export function FeedWatch({ names }) {
  const key = [...new Set(names)].sort().join("\u0000");
  useEffect(() => {
    if (!key) return undefined;
    const feeds = key.split("\u0000").map((name) => observeActivity(name, {
      changed: () => liveFeeds.set((s) => ({ n: s.n + 1 })),
      streamOn: appStore.get().streamOn,
      polling: () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling",
      wantThinking: () => activityPrefs.get().thinking,
      working: () => true,
    }));
    for (const f of feeds) f.start();
    return () => { for (const f of feeds) f.stop(); };
  }, [key]);
  return null;
}

/**
 * The context the lines are drawn from: the sub tasks' `handoffs`, their instances' states (read now: the page draws again with the store), how
 * many cards each has in progress and which open cards it could start (`doing`, `ready`: the board's), and the step line of a running one (only when this viewer is offered steps).
 */
export function flowContext(subs, handoffs, doing, ready = null) {
  const names = [...new Set((subs || []).map((c) => c.assignee).filter(Boolean))];
  const offered = activityOffered() && activityPrefs.get().on;
  return { handoffs: handoffs || [], states: instanceStates(appStore.get(), names), doing, ready, live: offered ? liveLineOf : () => "", now: Date.now() };
}

/** The instances whose steps this page should hold: those running a sub task (and not shared with another card), when steps are offered. */
export function watchedNames(subs, ctx) {
  if (!(activityOffered() && activityPrefs.get().on)) return [];
  return (subs || []).filter((c) => { const l = subLine(c, { ...ctx, live: () => "" }); return !!l && l.kind === "running"; }).map((c) => c.assignee);
}

// ── What is drawn ─────────────────────────────────────────

const ICON = { wait: "clock", ok: "check", done: "check", busy: "clock", bad: "alert", warn: "alert", muted: "info" };

/** One line's content: a turning ring while it is running, an icon otherwise, then the words (the whole text in the tooltip). */
export function LineBody({ line }) {
  return html`${line.spin ? html`<span class="out-spin tf-spin" aria-hidden="true"></span>` : html`<${Icon} name=${line.kind === "handed" ? "forward" : ICON[line.tone] || "info"} size=${13} />`}<span class="tf-says">${line.text}</span>`;
}

/** The short label beside a sub task's title (inside the row's button: the whole row opens the card); the whole sentence is the row's tooltip. */
export function RowChip({ line }) {
  if (!line || !line.chip) return null;
  return html`<span class=${`tf-chip tf-${line.tone}`}>${line.chip}</span>`;
}

/**
 * The sub tasks list: a row each of status, number, title and who. What is happening is in the row — no second line: a sub task its agent is running
 * has its title shimmer (still with reduced motion; the row is tinted as a running board row is), any other state is a short label beside the title, and the
 * whole sentence (with the step, for an admin whose agent has tool progress on) is the row's tooltip. While a sub task is running and steps are offered,
 * the page holds its instance's feed (`FeedWatch`) — the main task's "Agent activity" block shows the steps. `children`: the card read's sub tasks; `handoffs`: the card read's.
 */
export function SubRows({ children, handoffs, doing, ready = null, onOpen }) {
  useStore(appStore);
  useStore(liveFeeds);
  const ctx = flowContext(children, handoffs, doing, ready);
  const lines = children.map((c) => subLine(c, ctx));
  useClock(lines.some(turning));
  return html`<${FeedWatch} names=${watchedNames(children, ctx)} />
    <ul class="tc-children">${children.map((c, i) => {
      const line = lines[i], running = !!line && line.kind === "running";
      return html`<li key=${c.id}><button type="button" class=${running ? "is-running" : undefined} title=${line ? line.tip || line.text : undefined} data-line=${line ? line.kind : undefined} onClick=${() => onOpen(c.id)}>
      <${StatusPill} status=${c.status} card=${c} /><span class="tb-code">${c.id}</span>
      <span class="tc-child-title"><span class=${running ? "tf-shimmer" : undefined}>${c.title}</span><${RowChip} line=${line} /></span><span class="tb-who">${c.assignee || ""}</span></button></li>`;
    })}</ul>`;
}

/** The main task's "Agent activity" lines: one per sub task that has something going on, the sub task's number opens it. */
export function FlowLines({ subs, handoffs, doing, ready = null, onOpen }) {
  useStore(liveFeeds);
  const ctx = flowContext(subs, handoffs, doing, ready);
  const { lines, more } = mainLines(subs, ctx);
  useClock(lines.some((x) => turning(x.line)));
  if (!lines.length) return null;
  return html`<ul class="tf-lines" aria-label=${t("taskflow.linesLabel")}>${lines.map(({ card, line }) => html`<li key=${card.id} class=${`tf-item tf-${line.tone} tf-k-${line.kind}`} title=${line.tip || line.text}>
    <${LineBody} line=${line} /><button type="button" class="tb-link tb-code tf-card" title=${t("taskflow.openCard", card.id)} onClick=${() => onOpen(card.id)}>${card.id}</button></li>`)}
    ${more ? html`<li class="tf-extra muted">${t("taskflow.more", more)}</li>` : null}</ul>`;
}

/** Whether the main task has lines to show, for its block to open (the block itself draws `FlowLines`). */
export const hasFlow = (subs, handoffs, doing, ready = null) => mainLines(subs, flowContext(subs, handoffs, doing, ready)).lines.length > 0;

/** A handoff in the activity stream: a row that is never folded away — the sentence, its time, and where it stands under it. */
export function BatonEntry({ entry, states, runFor = null }) {
  useStore(liveFeeds);                           // the step line moves with the feed: only this row redraws, not the stream
  const run = runFor ? runFor(entry) : null;
  useClock(turning(run));
  const { lead, status: handed } = batonOf(entry.h, states, entry.started);
  // The card is still open but its agent is running on it (not claimed): the row says so, with the step, instead of where the notice stands.
  const status = !entry.started && run ? { tone: run.tone, text: run.text, tip: run.tip, spin: true } : handed;
  return html`<li class="tl-item tl-baton" data-baton=${entry.h.card} aria-label=${t("taskflow.handoffLabel")}>
    <div class="tl-line"><span class="tl-mark" aria-hidden="true"><${Icon} name="forward" size=${14} /></span>
      <span class="tl-sentence">${lead}</span>
      <time class="muted tl-time" dateTime=${entry.at}>${relTime(entry.at)}</time></div>
    ${status ? html`<ul class="tl-wakes tf-wakes"><li class=${`tl-wake wk-${status.tone}`} title=${status.tip || undefined}>${status.spin ? html`<span class="out-spin tf-spin" aria-hidden="true"></span>` : html`<${Icon} name=${ICON[status.tone] || "info"} size=${13} cls=${status.tone === "busy" ? "wk-spin" : ""} />`}<span>${status.text}</span></li></ul>` : null}
  </li>`;
}

/**
 * The running line of the card a handoff row is about, when that is its newest handoff to its current assignee and the assignee is running on it
 * without having claimed it (`subLine`'s running, unclaimed) — else null. The card is the card read's own or one of its children.
 */
export function batonRun(h, detail, doing, ready) {
  const card = detail && (detail.card && detail.card.id === h.card ? detail.card : ((detail.children || []).find((c) => c.id === h.card) || null));
  if (!card || card.status !== "open") return null;
  const latest = latestHandoff(detail.handoffs, card);
  if (!latest || latest.id !== h.id) return null;
  const line = subLine(card, flowContext([card], detail.handoffs, doing, ready));
  return line && line.kind === "running" && line.unclaimed ? line : null;
}

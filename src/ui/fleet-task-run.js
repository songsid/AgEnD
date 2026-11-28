// What the agent is doing on a card (Fleet › Tasks). The board knows a card's assignee and its status; the
// dashboard already knows each instance's state (working, waiting for you, stuck, idle) and, for an admin, its steps (the
// chat's activity block). This puts them side by side: a card in progress whose assignee is working is "running".
//
// The match is an INFERENCE, not a record: AgEnD has no run per card — an instance is one continuing session. A card in
// `claimed` and its assignee working are taken for one thing, which is exact while the assignee has that one card in
// progress (the default, `board_cards_at_once: 1`). With several in progress (a higher limit, or a person dragged some
// there) nothing says which one the assignee is on: each of them says "busy, N cards" and none says "running". Nothing is
// stored and nothing is added to the API; an instance the viewer cannot see, a card nobody has, or steps that are not
// offered show nothing (or the state alone). The board reads the dashboard's store ONCE (useRunContext), only for the
// instances that have a card in progress, and redraws only when one of THEIR states changes — a tile and a row never
// subscribe to the store themselves. No style attribute anywhere (the CSP).
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { dotState } from "/assets/instance-nav.js";
import { chatPath, detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { ActivityBlock, activityDrawCtx, activityOffered, activityPrefs, activitySnapshot, observeActivity } from "./chat-activity.js";
import { SHOWN, TIME_SLACK_MS, hasSubstance } from "./chat-activity-groups.js";
import { Who, waitsOn } from "./fleet-task-common.js";

register("taskrun", {
  en: {
    title: "Agent activity", running: "Running", needs: "Needs you", stuck: "Looks stuck", idle: "Idle", sharedMark: "Busy · {0} cards", byAgent: "Agent", byAgentTip: "Made by an agent",
    openChat: "Open conversation", openChatTip: "{0}'s conversation: its replies and, where shown, its steps",
    idleNote: "{0} has this card in progress but is idle right now.",
    sharedNote: "{0} has {1} cards in progress, so what it is doing now may belong to another of them.",
    stepsOff: "{0}'s tool progress is off, so its steps are not shown here.", stepsOffLink: "Turn it on in its settings",
    noSteps: "This agent's runtime does not offer its steps.",
    waiting: "Not started: {0} will update this once it takes the card", waitingNobody: "Not started: whoever takes the card will update this",
    viaSubs: "The work is in its sub tasks: each one's agent updates its own card", nothingYet: "No state or result written yet",
    runningUnclaimed: "Running · not claimed", unclaimedTip: "{0} is working and this is the card it was given, but it has not moved it to In progress (it did not claim it): what it is doing now is probably this card",
    unclaimedNote: "{0} is working and has this card, but has not claimed it — the board shows work only once a card is in progress.",
  },
  "zh-TW": {
    title: "Agent 活動", running: "執行中", needs: "等你回應", stuck: "似乎卡住", idle: "閒置", sharedMark: "忙碌中 · {0} 張卡", byAgent: "Agent", byAgentTip: "由 Agent 做的",
    openChat: "開啟對話", openChatTip: "{0} 的對話：它的回覆，以及（有顯示時）它的步驟",
    idleNote: "{0} 手上有這張進行中的卡，但目前閒置。",
    sharedNote: "{0} 同時有 {1} 張卡在進行中，目前的動作可能屬於其中另一張。",
    stepsOff: "{0} 的工具進度是關閉的，所以這裡不顯示它的步驟。", stepsOffLink: "到它的設定開啟",
    noSteps: "這個 Agent 的執行環境沒有提供步驟。",
    waiting: "待啟動：{0} 接手後會在這裡更新", waitingNobody: "待啟動：有人接手後會在這裡更新",
    viaSubs: "工作在子任務裡：各子任務的 Agent 會在自己的卡上更新", nothingYet: "還沒有目前狀態或產出",
    runningUnclaimed: "執行中・尚未認領", unclaimedTip: "{0} 正在執行，而這是交給它的卡，但它還沒有把卡片移到進行中（沒有認領）：它現在做的很可能就是這張",
    unclaimedNote: "{0} 正在執行，手上有這張卡，但還沒有認領——卡片要移到進行中，板子才會顯示有人在做。",
  },
});

// ── What is running (pure: tests import these) ───────────────

/** The states a card shows, strongest first: working, then waiting for the person, then stuck, then idle. */
export const RUN_RANK = { working: 0, needs: 1, stuck: 2, idle: 3 };

/**
 * How many board cards each instance has in progress, by name — what `task mine` counts: cards in `claimed`, a main task
 * that follows its sub tasks aside (its sub tasks are the work).
 */
export function inProgressBy(cards) {
  const out = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.status !== "claimed" || !c.assignee) continue;
    if (c.kind === "main" && c.progress && c.progress.total > 0) continue;
    out.set(c.assignee, (out.get(c.assignee) || 0) + 1);
  }
  return out;
}

/**
 * The open cards each instance has that it could start now — nothing left to wait for (the card's own `unmetDeps`, and one it cannot see) —
 * by name, as card numbers. A main task that follows its sub tasks aside (its sub tasks are the work). With `inProgressBy`, what says whether a
 * working instance with nothing in progress is probably on its one open card (`runUnclaimed`).
 */
export function readyOpenBy(cards) {
  const out = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.status !== "open" || !c.assignee) continue;
    if (c.kind === "main" && c.progress && c.progress.total > 0) continue;
    if (waitsOn(c)) continue;
    out.set(c.assignee, [...(out.get(c.assignee) || []), c.id]);
  }
  return out;
}

/**
 * The state of each named instance the viewer sees (`dotState`: working, needs, stuck, idle, stopped…), as a map by name —
 * read from the dashboard's store state `{ instances, exec, awaiting }`. A name the viewer does not see is not in it.
 */
export function instanceStates(store, names) {
  const out = new Map();
  const instances = (store && store.instances) || [];
  for (const name of names) {
    const it = instances.find((i) => i.name === name);
    if (it) { const state = dotState(it, ((store && store.exec) || {})[name], ((store && store.awaiting) || {})[name]); out.set(name, state); noteState(name, state); }
  }
  return out;
}

// When THIS page saw an instance start working (it was not working, then it was): `runUnclaimed` does not take work that began before a card was
// handed over for work on it (a chat, another job). Nothing is stored or sent: a page opened while the instance is already working has no start
// (undefined: it cannot say, and does not hold that against the card). Updated wherever a state is read.
const lastSeen = new Map();
const workStarts = new Map();
function noteState(name, state) {
  const was = lastSeen.get(name);
  lastSeen.set(name, state);
  if (state !== "working") workStarts.delete(name);
  else if (was !== undefined && was !== "working" && !workStarts.has(name)) workStarts.set(name, Date.now());
}
/** Tests only: what this page has seen of the instances' states. */
export function forgetWorkStarts() { lastSeen.clear(); workStarts.clear(); }
/** When this page saw `name` start working (epoch ms), or undefined. */
export const workStartOf = (name) => workStarts.get(name);

/** A working instance began before the card was handed to it this long ago (clock slack) is not taken to be on that card. */
const HAND_SLACK_MS = 10_000;

/**
 * What an instance is doing on a card that is still open, though it is working: it was given the card (the board told it — `card.handedAt`),
 * can start it, has nothing in progress and no other open card it could be on, and did not start working before it was handed the card — so what
 * it is doing now is probably this card, which it has not claimed. An INFERENCE like `runOf`'s (an agent is one continuing session): `{ instance,
 * state: "working", shared: 0, unclaimed: true }`, or null. An agent once worked for six minutes on an assigned card without claiming it, and
 * the board said nothing; the notice now asks it to claim first, and this says what it cannot hide. Not an agent that is only chatting: a card the
 * board never handed it (no `handedAt`) is not evidence, and neither is work this page saw begin before the hand-over (`workStartOf`).
 * `ctx`: { states, doing, ready, workStart? } — `readyOpenBy` of the board; without `ready` (a caller from before) there is no such run;
 * `workStart` (a Map by name) stands in for what this page observed.
 */
export function runUnclaimed(card, ctx) {
  const name = card && card.assignee;
  if (!name || !ctx || card.status !== "open" || waitsOn(card)) return null;
  if (card.kind === "main" && card.progress && card.progress.total > 0) return null;
  const handed = Date.parse(card.handedAt || "");
  if (!Number.isFinite(handed)) return null;                                      // the board never handed it to this instance: not evidence
  if (!(ctx.states && ctx.states.get(name) === "working")) return null;
  if (((ctx.doing && ctx.doing.get(name)) || 0) > 0) return null;                // a card in progress is its work
  const mine = ctx.ready && ctx.ready.get(name);
  if (!mine || mine.length !== 1 || mine[0] !== card.id) return null;            // none, or several it could be on: nothing says which
  const began = ctx.workStart ? ctx.workStart.get(name) : workStartOf(name);
  if (began !== undefined && began < handed - HAND_SLACK_MS) return null;        // it was already at work before the card came: that work is something else
  return { instance: name, state: "working", shared: 0, unclaimed: true };
}

/**
 * What a card's assignee is doing on it, or null (nothing to say): { instance, state: working | needs | stuck | idle, shared, unclaimed? }
 * — `shared`: how many cards the assignee has in progress when that is more than this one (then which one it is on is
 * not known), else 0; `unclaimed`: it is working on the card it was given without having claimed it (`runUnclaimed`). Only a card in progress
 * has one (or an open one the working assignee probably is on), and only while its assignee is an instance the viewer sees, running.
 * A main task that follows its sub tasks has its running sub tasks' (the strongest, a claimed one first); `subs`: the ones the page shows.
 * `ctx`: { states, doing, ready } — `instanceStates` of the instances with a card in progress or open, `inProgressBy` and `readyOpenBy` of the board.
 */
export function runOf(card, ctx, subs = []) {
  if (!card) return null;
  if (card.kind === "main" && card.progress && card.progress.total > 0) {
    if (card.status !== "claimed" && card.status !== "open") return null;
    const runs = (subs || []).map((s) => runOf(s, ctx)).filter(Boolean)
      .sort((a, b) => RUN_RANK[a.state] - RUN_RANK[b.state] || (a.unclaimed ? 1 : 0) - (b.unclaimed ? 1 : 0));
    return runs[0] || null;
  }
  if (card.status === "open") return runUnclaimed(card, ctx);
  if (card.status !== "claimed") return null;
  const name = card.assignee;
  if (!name || !ctx) return null;
  const state = ctx.states && ctx.states.get(name);
  if (!(state in RUN_RANK)) return null;
  const n = (ctx.doing && ctx.doing.get(name)) || 0;
  return { instance: name, state, shared: n > 1 ? n : 0 };
}

/** A signature of some states, to tell whether any changed. */
const signature = (states) => [...states].map(([name, state]) => `${name}\u0000${state}`).sort().join("\u0001");

/**
 * What the board needs to say "running" on every tile and row: `{ states, doing, ready }` for `runOf`. ONE read of the dashboard's
 * store for the whole board, and only of the instances that have a card in progress (the only ones a mark can name):
 * it redraws when one of THOSE states changes, not on every store change (a status poll, a message) — a tile or a row
 * subscribes to nothing. Computed from the store as it is at each draw, so a card that came in progress is never drawn
 * with a state from before.
 */
export function useRunContext(cards) {
  const doing = useMemo(() => inProgressBy(cards), [cards]);
  const ready = useMemo(() => readyOpenBy(cards), [cards]);
  const names = useMemo(() => [...new Set([...doing.keys(), ...ready.keys()])], [doing, ready]);
  const [, redraw] = useState(0);
  const states = instanceStates(appStore.get(), names);
  const drawn = useRef("");
  drawn.current = signature(states);
  useEffect(() => {
    const changed = () => signature(instanceStates(appStore.get(), names)) !== drawn.current;
    if (changed()) redraw((n) => n + 1);     // moved between the draw and this subscription
    return appStore.subscribe(() => { if (changed()) redraw((n) => n + 1); });
  }, [names]);
  return useMemo(() => ({ states, doing, ready }), [doing, ready, drawn.current]);
}

/**
 * When the card was last put in progress, in epoch ms (0: unknown): its newest move to `claimed` in the history, else
 * the time it first started. Steps older than this are not this card's.
 */
export function claimedSince(detail) {
  let at = 0;
  for (const ev of (detail && detail.history) || []) {
    if (ev && ev.type === "moved" && ev.data && ev.data.to === "claimed") at = Math.max(at, Date.parse(ev.at) || 0);
  }
  return at || Date.parse((detail && detail.card && detail.card.startedAt) || "") || 0;
}

/**
 * The live group the chat's ActivityBlock draws, from the steps an instance's feed holds: those since `since` (the
 * newest turn's, when it is not known), thinking left to the block's own switch. Null when there is nothing to draw
 * from: no answer yet, the server offers nothing for good, the agent's tool_progress is off, or its backend has no steps.
 */
export function liveGroupOf(snap, { since = 0, busy = true } = {}) {
  if (!snap || snap.dead || !snap.info || snap.info.level === "off" || snap.info.supported === false) return null;
  const shown = (snap.steps || []).filter((s) => SHOWN.has(s.kind) && hasSubstance(s));
  let items;
  if (since) items = shown.filter((s) => !s.ts || s.ts >= since - TIME_SLACK_MS);
  else {
    const last = shown[shown.length - 1];
    items = last ? shown.filter((s) => s.turn === last.turn) : [];
  }
  const from = (items[0] && items[0].ts) || since || 0;
  const first = (snap.steps || [])[0];
  const partial = !!since && !snap.complete && !!first && Number.isFinite(first.ts) && first.ts > since;
  return {
    key: "act:card", turn: "card", n: 0, level: "live", rowKey: null, items, trailing: [], ts: from, from, to: 0, ended: false, turnEnded: false,
    busy, atEnd: true, ...(snap.phase ? { phase: snap.phase } : {}), ...(partial ? { partial: true } : {}),
  };
}

// ── What is drawn ─────────────────────────────────────────

/** A state in words, capitalised for a chip ("needs you" is the dashboard's own wording). */
const stateWord = (state) => t(`taskrun.${state === "working" ? "running" : state}`);

/** "Running" (or "Busy · N cards", "Needs you", "Looks stuck") beside a tile's or a row's number; idle says nothing there. */
export function RunMark({ run }) {
  if (!run || run.state === "idle") return null;
  const word = run.unclaimed ? t("taskrun.runningUnclaimed") : run.state === "working" && run.shared ? t("taskrun.sharedMark", run.shared) : stateWord(run.state);
  return html`<span class=${`tr-mark s-${run.state}${run.shared ? " shared" : ""}${run.unclaimed ? " unclaimed" : ""}`} title=${run.unclaimed ? t("taskrun.unclaimedTip", run.instance) : `${run.instance}: ${word}`}>
    <span class="tr-dot" aria-hidden="true"></span>${word}</span>`;
}

/** A timeline entry's "Agent" tag: made by an instance (the entry says so; an older one that does not gets none). */
export function AgentTag() {
  return html`<span class="tb-tag tr-by" title=${t("taskrun.byAgentTip")}><${Icon} name="bot" size=${12} />${t("taskrun.byAgent")}</span>`;
}

/** The feed of `name`'s steps (the chat's own read, live by `steps_tick`), held while `on`; redraws when it changes. */
function useFeed(name, on, busy) {
  const [, bump] = useState(0);
  const working = useRef(busy);
  working.current = busy;
  useEffect(() => {
    if (!on || !name) return undefined;
    const feed = observeActivity(name, {
      changed: () => bump((n) => n + 1),
      streamOn: appStore.get().streamOn,
      polling: () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling",
      wantThinking: () => activityPrefs.get().thinking,
      working: () => working.current,
    });
    feed.start();
    return () => feed.stop();
  }, [name, on]);
}

/**
 * What a card's agent block says when there is nothing to show yet (pure: tests import it): waiting for someone to take the
 * card, work that lives in its sub tasks, or just that nothing is written. `run`: this card's `runOf`, if any — an assignee
 * that has the card in progress and is idle says so (the one thing it can know).
 */
export function handoffNote(card, { derived = false, run = null, baton = "" } = {}) {
  if (run && run.state === "idle") return t("taskrun.idleNote", run.instance);
  // `baton`: where the card stands in the hand-over (waits for S-1, handed to dev, dev read it…) — fleet-task-flow.js's line for it.
  if (card.status === "open") return baton || (card.assignee ? t("taskrun.waiting", card.assignee) : t("taskrun.waitingNobody"));
  return derived ? t("taskrun.viaSubs") : t("taskrun.nothingYet");
}

/**
 * A card's agent block (Fleet › Tasks › a card's page): everything an agent writes or does on the card, apart from the
 * people's spec above it. With nothing to show — no state or result written (`shown` is empty), the agent not running — it is
 * one quiet line saying so (`adders`: the buttons that open the empty fields, a writer's way in; the way to the assignee's
 * conversation stays). With a state or result, or while the assignee is working, it opens up: who, their state, the way to their
 * conversation, the live steps (an admin, tool progress on), then the fields (`shown`) and the buttons for the empty ones.
 * `doing`: `inProgressBy` of the board. `derived`: a main task that follows its sub tasks has no agent of its own (its sub
 * tasks' pages do), whatever its assignee field says — what they are doing is `flow` (fleet-task-flow.js's `FlowLines`, drawn when
 * `flowOn`: a sub task is running, waiting for the person, handed on…), and without it the block is the one quiet line. `baton`: a card
 * that waits to start says where the hand-over stands, in words (`handoffNote`).
 */
export function AgentRun({ card, detail, doing, ready = null, derived = false, shown = [], adders = [], flow = null, flowOn = false, baton = "" }) {
  const store = useStore(appStore);            // one card's page: one subscription
  useStore(activityPrefs);
  const name = !derived && card.assignee ? card.assignee : null;
  const it = name ? (store.instances || []).find((i) => i.name === name) : null;
  const run = it ? runOf(card, { states: instanceStates(store, [name]), doing, ready }) : null;
  const live = !!run && run.state !== "idle";
  const offered = live && activityOffered() && activityPrefs.get().on;
  useFeed(name, offered, live);
  const chat = it ? html`<a class="btn btn-sm tr-open" href=${chatPath(name)} title=${t("taskrun.openChatTip", name)}><${Icon} name="chat" size=${14} />${t("taskrun.openChat")}</a>` : null;
  const extras = adders.length ? html`<span class="tp-adders">${adders}</span>` : null;
  if (!live && !shown.length && !flowOn) {
    return html`<section class="tr-run tp-agent is-strip" aria-label=${t("taskrun.title")}>
      <span class="tp-agent-icon" aria-hidden="true"><${Icon} name="bot" size=${16} /></span>
      <span class="tr-title">${t("taskrun.title")}</span>
      <span class="tp-agent-note">${handoffNote(card, { derived, run, baton })}</span>
      <span class="tb-grow"></span>${extras}${chat}
    </section>`;
  }
  const snap = offered ? activitySnapshot(name) : null;
  const group = snap ? liveGroupOf(snap, { since: claimedSince(detail), busy: live }) : null;
  const off = snap && !snap.dead && snap.info && snap.info.level === "off";
  const none = snap && snap.info && snap.info.supported === false;   // (the feed then holds nothing for good: dead)
  const word = run ? stateWord(run.state) : "";
  return html`<section class="card lbar tr-run tp-agent" aria-label=${t("taskrun.title")}>
    <div class="tr-head">
      <span class="tp-agent-icon" aria-hidden="true"><${Icon} name="bot" size=${16} /></span>
      <h3 class="tr-title">${t("taskrun.title")}</h3>
      ${it ? html`<${Who} name=${name} />` : null}
      ${run ? html`<span class=${`tr-state s-${run.state}`}><span class="tr-dot" aria-hidden="true"></span>${word}</span>` : null}
      <span class="tb-grow"></span>
      ${chat}
    </div>
    ${flowOn ? flow : null}
    ${run && run.state === "idle" ? html`<p class="muted tr-note">${t("taskrun.idleNote", name)}</p>` : null}
    ${run && run.shared ? html`<p class="muted tr-note">${t("taskrun.sharedNote", name, run.shared)}</p>` : null}
    ${run && run.unclaimed ? html`<p class="tr-note tr-unclaimed">${t("taskrun.unclaimedNote", name)}</p>` : null}
    ${group ? html`<${ActivityBlock} group=${group} ctx=${activityDrawCtx(name)} />` : null}
    ${off ? html`<p class="muted tr-note">${t("taskrun.stepsOff", name)} <a class="link" href=${detailsPath(name)}>${t("taskrun.stepsOffLink")}</a></p>` : null}
    ${none ? html`<p class="muted tr-note">${t("taskrun.noSteps")}</p>` : null}
    ${shown.length ? html`<div class="tp-agent-fields">${shown}</div>` : null}
    ${extras ? html`<div class="tp-agent-add">${extras}</div>` : null}
  </section>`;
}

// #1408 step 3: the Settings panel (/settings[/<section>]) — agents, connections, ClassicBot rooms, general defaults,
// the developer YAML. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// What it owns (§5):
// - The configuration it shows: read when it mounts (a person's navigation, so it counts as use, #1374), dropped when
//   it goes. Nothing recurring. A section change is the same panel and keeps everything.
// - The staged changes: data, kept across sections. Leaving the panel with any asks "Discard N pending changes?" (the
//   router's leave guard; the browser's own prompt for a reload or another site).
// - Not the Apply: confirming hands the staged changes to the app's runner (settings-apply.js) before the first write.
//   This panel renders that operation from the store, and finds it again when it mounts.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { DevicePrefs, PanelHeader, PendingChanges, setTitle } from "/assets/app-shell.js";
import { navigate, navStore, setLeaveGuard } from "/assets/app-nav.js";
import { chatPath, settingsPath, SETTINGS_SECTIONS } from "/assets/app-route.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import { GroupMark, groupLabel, groupOf as navGroupOf, modelText } from "/assets/instance-nav.js";
import "./settings-strings.js";
import { api, attach, confirmedWrite, newKey } from "./settings-confirm.js";
import { dismissOperation, operationActive, restartFleet, startOperation, takeLeftover } from "./settings-apply.js";
import {
  ACCESS_MODES, AGENT_MODES, DEFAULT_SCHEMA, HANG_TIMEOUT_DEFAULT_MINUTES, LOG_LEVELS, TOOL_PROGRESS, TOOL_SETS, VISIBILITY_MODES, batchImpact,
  changedFields, channelId, channelsOf, chLabel, connectionState, effectiveSummary, fleetModel, fromYaml, fullModelRequests, groupAgents,
  hasOwn, impactOf, localeOptions, defaultsImpact, requestImpact, nonNegative, positive, replyGuardSupported, sameValue, shortName, STATUS_ORDER, toYaml,
  visibilityDefault, worstImpact,
} from "./settings-model.js";
import {
  AgentDialog, BackendSelect, BotDialog, ChipList, ClassicDialog, Drawer, Feedback, Impact, Label, ModelSelect, NewBotDialog, Override,
  Select, ask, impactText,
} from "./settings-dialogs.js";
import { SetupWizard } from "./settings-wizard.js";
import { CreateInstanceDialog } from "./panel-fleet.js";
import { FirstRunCard, takeWizardRequest } from "./first-run.js";
import { takeAgentRequest } from "./settings-request.js";
// #1604: This device — the preview opt-in (one path: the app's confirm, then preview.js) and the tour, from the chat.
import { setPreviewOptIn } from "./panel-chat.js";
import { startTour } from "./chat-tour.js";
import "./chat-strings.js";
import { AppearanceSection } from "./settings-appearance.js";
import { GuestsCard } from "./settings-guests.js";
import { fleetReadOnly, syncStage, useDraft } from "./settings-draft.js";
import { WebAuthorityCard } from "./settings-web-authority.js";
import { SignInList } from "./backend-signin.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
/** What a refused change says to a person: the server's code in words (the code itself only for one not listed). */
const APPLY_ERRORS = new Set(["unsupported_sensitive_effect", "confirmation_diff_too_large", "session_required", "admin_required", "settings_changed",
  "request_no_longer_current", "too_many_pending_changes", "fleet_unavailable", "invalid_settings_effect", "settings_confirmation_unavailable", "failed"]);
export const applyErrorText = (code) => (APPLY_ERRORS.has(code) ? tn(`applyError_${code}`) : tn("applyErrorOther", String(code)));
const ICONS = { device: "user", appearance: "palette", agents: "bot", bots: "plug", classic: "room", general: "sliders", web: "globe", advanced: "code" };
const RELEASES = "https://github.com/songsid/AgEnD/releases";

/** GET under the panel's lease → { ok, status, body }. */
async function read(lease, path) {
  const r = await lease.fetch(path);
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

let loads = 0;
/** Everything the panel shows, in the order the old page read it. Returns null if the lease ended meanwhile. */
async function loadAll(lease) {
  const out = { schema: DEFAULT_SCHEMA };
  const schema = await read(lease, "/api/settings/schema");
  if (!lease.current()) return null;
  if (schema.ok && schema.body) out.schema = schema.body;
  // Forms edit the user-authored config, not defaults-expanded runtime values.
  const fleet = await read(lease, "/api/settings/fleet/raw");
  if (!lease.current()) return null;
  if (!fleet.ok) return { error: true };
  out.fleet = fleet.body || {};
  const classic = await read(lease, "/api/settings/classic");
  if (!lease.current()) return null;
  out.classic = classic.body || {};
  const connections = await read(lease, "/api/settings/connections");
  if (!lease.current()) return null;
  out.connections = connections.ok && Array.isArray(connections.body) ? connections.body : [];
  // Only where the fleet offers them (the schema says so): otherwise the route is a 404 and there is nothing to show.
  const secrets = out.schema && out.schema.provider_secrets === false ? { ok: false } : await read(lease, "/api/settings/provider-secrets");
  if (!lease.current()) return null;
  out.providerOk = secrets.ok;
  out.providerSecrets = secrets.ok && Array.isArray(secrets.body) ? secrets.body : [];
  const live = await loadLive(lease);
  if (!live) return null;
  return { ...out, ...live, loadedAt: ++loads };
}
async function loadLive(lease) {
  const f = await read(lease, "/api/fleet");
  if (!lease.current()) return null;
  const live = {}, classicLive = {};
  if (f.ok && f.body && Array.isArray(f.body.instances)) for (const i of f.body.instances) {
    live[i.name] = { status: i.status, state: i.state, backend: i.backend, model: i.model, model_display: modelText(i, i.model_display), effort: i.effort, effort_supported: i.effort_supported };
    if (i.classic) classicLive[i.name] = { status: i.status, state: i.state };
  }
  // /api/fleet carries live state for ClassicBot rooms; the profiles are the fallback for one not listed there yet.
  const pr = await read(lease, "/api/profiles");
  if (!lease.current()) return null;
  const classicStatus = {};
  if (pr.ok && Array.isArray(pr.body)) for (const r of pr.body) classicStatus[r.instance_name] = r.status;
  return { live, classicLive, classicStatus, fleetUp: f.ok, version: (f.ok && f.body && f.body.version) || "" };
}

export function SettingsPanel({ route, navKey }) {
  const section = SETTINGS_SECTIONS.includes(route.section) ? route.section : "agents";
  const mount = useLease("settings");                 // the panel's life on screen: its data, its guard
  const [data, setData] = useState(null);
  const [staged, setStaged] = useState(() => new Map());
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const [dialog, setDialog] = useState(null);         // { kind, ...props, key: navKey }
  const [search, setSearch] = useState("");
  // #2347: each section's draft while it is edited (settings-draft.js), and the epoch that remounts the sections when
  // the drafts go: a Save that went through whole, or Discard. A Save that failed keeps them (what did not land is staged
  // again, and the form still shows it).
  const drafts = useRef(new Map());
  const [draftEpoch, setDraftEpoch] = useState(0);
  // A staged change's onResult hears how its Save settled: "applied", "waiting" (for a fleet admin's OK) or "failed".
  const results = useRef(new Map());
  const readOnly = fleetReadOnly();
  // The drafts as they were when a Save began. #2367 review: the form stays editable while it runs, so a Save that went
  // through drops only the drafts it saved — one edited since (in any section) stays, and stays staged.
  const submitted = useRef(null);
  // The staged changes as they were when that Save began (what comes back after a failure is them, whole: a section's
  // draft and onResult included), and how a Save went for a change whose section was shown again since (#2367 review:
  // a failed Save reloads, so the section that staged it is a new one by the time it could be told).
  const submittedStaged = useRef(new Map());
  const outcomes = useRef(new Map());
  // #2367 r3: how the last Save went for each change it carried ("applied" / "failed"), until its configuration is read
  // back: a change staged against both ends of a Save (`afterSave: { applied, failed }`) becomes the one that came true.
  const settledAs = useRef(new Map());
  const resolveAfterSave = (key, change) => {
    if (!change || !change.afterSave) return change;
    const v = change.afterSave[settledAs.current.get(key) === "applied" ? "applied" : "failed"];
    return v ? { ...v, stageKey: key } : null;
  };
  const dropDrafts = (saved = null) => {
    drafts.current = saved ? new Map([...drafts.current].filter(([k, v]) => !saved.has(k) || !sameValue(v, saved.get(k)))) : new Map();
    setDraftEpoch((n) => n + 1);
  };
  const { settingsOp: op, pendingChanges } = useStore(appStore);
  const gen = useRef(0);

  useEffect(() => { setTitle(`${tn("title")} · ${tn(`sec_${section}`)}`); }, [section, navKey]);

  const reload = async () => {
    const mine = ++gen.current;
    const next = await loadAll(mount);
    if (!next || mine !== gen.current || !mount.current()) return;
    setData(next);
  };
  const reloadLive = async () => {
    const mine = gen.current;
    const live = await loadLive(mount);
    if (!live || mine !== gen.current || !mount.current()) return;
    setData((d) => (d && !d.error ? { ...d, ...live } : d));
  };

  // Mount: the data; requests still waiting for an admin from before a reload; the leave guard; the browser's prompt.
  useEffect(() => {
    reload();
    attach();
    // Leaving with staged changes asks in the app's dialog; the navigation waits, and goes on (past the guard) on a yes.
    let asking = false;
    mount.hold(setLeaveGuard((to, path) => {
      const n = stagedRef.current.size;
      if (!n || (to && to.panel === "settings")) return true;
      if (!asking) {
        asking = true;
        ask(tn("discardOnLeave", n), { confirmLabel: tn("discard"), danger: true }).then((yes) => {
          asking = false;
          if (!yes || !mount.current()) return;
          dropSecrets(stagedRef.current);
          stagedRef.current = new Map();
          navigate(path, { force: true });
        });
      }
      return false;
    }));
    mount.on(window, "beforeunload", (e) => { if (stagedRef.current.size) { e.preventDefault(); e.returnValue = ""; } });
  }, [mount]);

  // Changes a failed Apply did not land come back to be staged again (secrets excepted: they are entered again).
  useEffect(() => {
    if (!op || !op.leftover || !op.leftover.length) return;
    const back = takeLeftover();
    if (!back.length) return;
    setStaged((s) => {
      const m = new Map(s);
      // #2367 review: a change staged for the same thing since that Save began is the newer word (its draft and
      // request carry everything still unsaved): it stays, and the failed one is not put back over it.
      for (const c of back) {
        const k = c.stageKey || newKey("left");
        if (!m.has(k)) m.set(k, { ...(submittedStaged.current.get(k) || {}), ...c, stageKey: k });
      }
      return m;
    });
  }, [op && op.leftover]);

  // An Apply that finished, or a confirmed request that applied, changed the configuration: read it again.
  const lastPhase = useRef(op ? op.phase : null);
  useEffect(() => {
    const phase = op ? op.phase : null;
    if (lastPhase.current !== phase && (phase === "done" || phase === "failed")) {
      settle(op);
      settledAs.current = new Map(op.steps.filter((s) => s.stageKey).map((s) => [s.stageKey, s.status === "done" ? "applied" : "failed"]));
      setStaged((s) => {
        if (![...s.values()].some((c) => c.afterSave)) return s;
        const m = new Map();
        for (const [k, c] of s) { const r = resolveAfterSave(k, c); if (r) m.set(k, r); }
        return m;
      });
      if (phase !== "done") settledAs.current = new Map();
      // After a Save that went through, its drafts go once the configuration it wrote is read back — not before: a
      // section shown on the old configuration would take an edit back to the old value for no edit at all.
      const saved = phase === "done" ? submitted.current : null;
      if (!saved) submitted.current = null;
      reload().finally(() => { if (saved && submitted.current === saved) { dropDrafts(saved); submitted.current = null; settledAs.current = new Map(); } });
    }
    lastPhase.current = phase;
  }, [op && op.phase]);
  // A saved change that waits for a fleet admin's OK is told so while it waits (its section says it is not saved yet).
  const waitingNow = op ? op.steps.filter((s) => s.status === "waiting" && s.stageKey).map((s) => s.stageKey).join(",") : "";
  useEffect(() => {
    for (const k of waitingNow ? waitingNow.split(",") : []) {
      const fn = results.current.get(k);
      try { if (fn) fn({ status: "waiting", error: null }); } catch { /* a section's own handler: never the Save's */ }
    }
  }, [waitingNow]);
  const applied = (pendingChanges || []).filter((p) => p.state === "applied").map((p) => p.id).join(",");
  useEffect(() => { if (applied) reload(); }, [applied]);

  const stage = (key, change, quiet = false) => {
    // A change staged against both ends of a Save that has settled since is the end that came true (none: nothing left).
    if (change && change.afterSave && settledAs.current.size) {
      change = resolveAfterSave(key, change);
      if (!change) { unstage(key); return; }
    }
    setStaged((s) => {
      const m = new Map(s);
      const prev = m.get(key);
      // Two edits of the same object before Apply: one change, the later values on top of the earlier ones.
      if (prev && prev.request && change.request && prev.request.method === "PATCH" && change.request.method === "PATCH") {
        change = { ...change, request: { ...change.request, body: { ...prev.request.body, ...change.request.body } } };
      }
      m.set(key, { ...change, stageKey: key });
      return m;
    });
    if (!quiet) toast(tn("queued", change.label));
    // A section shown again after its Save failed (or still waits) hears how it went as it stages its change again.
    if (typeof change.onResult === "function" && outcomes.current.has(key)) {
      const outcome = outcomes.current.get(key);
      outcomes.current.delete(key);
      try { change.onResult(outcome); } catch { /* a section's own handler: never the Save's */ }
    }
  };
  const unstage = (key) => setStaged((s) => { if (!s.has(key)) return s; const m = new Map(s); m.delete(key); return m; });
  const discard = () => { dropSecrets(staged); setStaged(new Map()); outcomes.current = new Map(); dropDrafts(); reload(); };
  /** Tell each saved change's section how its Save settled (#2347: the onResult in the change it staged). */
  const settle = (o) => {
    for (const step of (o && o.steps) || []) {
      const fn = step.stageKey && results.current.get(step.stageKey);
      if (!fn) continue;
      const status = step.status === "done" ? "applied" : step.status === "waiting" ? "waiting" : "failed";
      if (status !== "applied") outcomes.current.set(step.stageKey, { status, error: step.error || null });
      try { fn({ status, error: step.error || null }); } catch { /* a section's own handler: never the Save's */ }
    }
    results.current = new Map();
  };

  const applying = useRef(false);
  const apply = async () => {
    if (applying.current || operationActive() || !staged.size || readOnly) return;
    if ([...stagedRef.current.values()].some((c) => c.invalid)) return;    // #2347: Save waits for every field to be valid
    // Every confirmation before the first write: a cancelled one must not leave earlier changes applied and later
    // ones pending (a surprising partial apply).
    applying.current = true;
    try {
      // A panel that went while a question was open asks nothing more, and says nothing.
      for (const c of [...stagedRef.current.values()]) {
        for (const k of c.confirms || []) {
          const yes = await ask(tn(k));
          if (!mount.current()) return;
          if (!yes) { toast(tn("accessChangeCancelled"), false); return; }
        }
      }
    } finally { applying.current = false; }
    if (!mount.current() || operationActive()) return;
    const list = [...stagedRef.current.values()].map(({ label, impact, request, connectionSecret, stageKey, key }) => ({ label, impact, request, connectionSecret, stageKey, key }));
    const handlers = new Map([...stagedRef.current.values()].filter((c) => typeof c.onResult === "function").map((c) => [c.stageKey, c.onResult]));
    if (startOperation(list)) {
      results.current = handlers; submitted.current = new Map(drafts.current); submittedStaged.current = new Map(stagedRef.current);
      outcomes.current = new Map(); setStaged(new Map());
    }
  };

  // #2347: sections read `staged` (each change as staged, its extra fields kept: Guests carries its whole draft) and
  // `drafts` to come back to their edits; `draftEpoch` moves on Discard and after a Save to start them from what is saved.
  const ctx = data && !data.error ? makeCtx(data, setData, stage, unstage, reload, reloadLive, () => mount.current(),
    { drafts: drafts.current, draftEpoch, readOnly, staged, savingDrafts: () => submitted.current,
      savingStaged: () => (submitted.current || operationActive() ? submittedStaged.current : null) }) : null;
  // #1519 P7: "Connect a chat app" on the first-run card elsewhere came here for the wizard: it opens once the data is in.
  useEffect(() => { if (ctx && takeWizardRequest()) setDialog({ kind: "wizard", key: navKey }); }, [!!ctx, navKey]);
  // #1523 N2: "Edit in Settings" on an instance's Details: that agent's dialog, once the data is in — only an agent this
  // configuration has (own key), with Settings' own staged Apply and confirmations.
  useEffect(() => {
    if (!ctx) return;
    const want = takeAgentRequest();
    if (!want) return;
    const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
    if (want.kind === "classic") {
      // A ClassicBot room: its own dialog (ClassicDialog), found by its instance among this config's rooms.
      const rooms = (ctx.classic && ctx.classic.channels) || {};
      const key = Object.keys(rooms).find((k) => own(rooms, k) && rooms[k] && rooms[k].instanceName === want.name);
      if (key) setDialog({ kind: "classic", room: { key, ...rooms[key] }, key: navKey });
      return;
    }
    const insts = (ctx.fleet && ctx.fleet.instances) || {};
    if (own(insts, want.name)) setDialog({ kind: "agent", name: want.name, inst: insts[want.name], key: navKey });
  }, [!!ctx, navKey]);
  // #1604: This device needs no configuration: shown at once, whatever the configuration read does.
  const sectionBody = section === "device" ? html`<${DeviceSection} />`
    // #1629 r4 §3: Appearance is the person's own (no configuration read): shown at once, like Preferences.
    : section === "appearance" ? html`<${AppearanceSection} />`
    : !data ? html`<${Skeleton} lines=${6} />`
    : data.error ? html`<${ErrorState} message=${tn("configLoadFailed")} onRetry=${reload} />`
    : section === "agents" ? html`<${Agents} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} />`
    : section === "bots" ? html`<${Bots} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} />`
    : section === "classic" ? html`<${Classic} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} />`
    : section === "general" ? html`<${General} key=${`${data.loadedAt}:${draftEpoch}`} ctx=${ctx} />`
    : section === "web" ? html`<${WebSection} key=${`${data.loadedAt}:${draftEpoch}`} ctx=${ctx} staged=${staged} />`
    : html`<${Developer} ctx=${ctx} />`;
  // A dialog belongs to the navigation that opened it (its draft names one object, never another).
  const open = dialog && dialog.key === navKey ? dialog : null;
  const close = () => setDialog(null);
  const searchable = section === "agents" || section === "bots" || section === "classic";
  return html`<div data-effect-panel="settings" class="panel p-settings">
    <${PanelHeader} title=${tn("title")} sub=${data && data.version ? html`<a class="pill ver" href=${data.version.includes("-") ? `${RELEASES}/latest` : `${RELEASES}/tag/v${data.version}`} target="_blank" rel="noopener">v${data.version}</a>` : null}>
      <button type="button" class="btn btn-ghost btn-sm" disabled=${!ctx} onClick=${() => setDialog({ kind: "wizard", key: navKey })}><${Icon} name="wand" size=${16} /><span class="hide-narrow">${tn("wizardButton")}</span></button>
      <button type="button" class="icon-btn" aria-label=${tn("helpButton")} title=${tn("helpButton")} onClick=${() => setDialog({ kind: "help", key: navKey })}><${Icon} name="info" /></button>
    </${PanelHeader}>
    <nav data-trust="panel-navigation" class="seg" aria-label=${tn("title")}>${SETTINGS_SECTIONS.map((k) => html`<a key=${k} href=${settingsPath(k)} class=${`seg-item${k === section ? " active" : ""}`}
      aria-current=${k === section ? "page" : undefined}><${Icon} name=${ICONS[k]} size=${16} /><span>${tn(`sec_${k}`)}</span></a>`)}</nav>
    <div data-trust="panel-content" class="panel-body"><div class="col">
      ${searchable ? html`<div class="s-toolbar"><label class="s-search"><${Icon} name="search" size=${14} /><span class="sr-only">${tn("searchAll")}</span>
        <input type="search" value=${search} placeholder=${tn("searchAll")} onInput=${(e) => setSearch(e.target.value)} /></label></div>` : null}
      ${readOnly && section !== "device" && section !== "appearance" ? html`<p class="note s-readonly" role="status">${tn("fleetReadOnlyPublic")}</p>` : null}
      ${op ? html`<${OperationCard} op=${op} schema=${data && data.schema} />` : null}
      <${PendingChanges} inline=${true} />
      ${ctx && (section === "agents" || section === "bots") ? html`<${FirstRunCard} onConnect=${() => setDialog({ kind: "wizard", key: navKey })} />` : null}
      ${sectionBody}
    </div></div>
    ${staged.size && !readOnly ? html`<${PendingBar} staged=${staged} busy=${opBusy(op)} onApply=${apply} onDiscard=${discard} />` : null}
    ${open && ctx ? renderDialog(open, ctx, close) : null}
    ${open && open.kind === "help" ? html`<${HelpDialog} onClose=${close} />` : null}
  </div>`;
}

/**
 * #1604, #1665: Preferences. Synced across the person's devices (kept on the host, app-prefs.js): theme (theme.js),
 * language (app-i18n.js) and HTML previews (preview.js, through the app's confirm). On the public link they are
 * read-only: a change there stays in that browser, and it says so. This device only: the chat tour (replayed on the
 * chat it points at), and the layout choices named there (their controls are where they always were).
 */
export function DeviceSection() {
  const P = () => globalThis.AgendPreview;
  const [on, setOn] = useState(P() ? P().optedIn() : false);
  useEffect(() => (P() ? P().onChange(() => setOn(P().optedIn())) : undefined), []);
  const replay = () => {
    let last = null;
    try { last = localStorage.getItem("agend_last_instance"); } catch { /* none */ }
    // #1854: the tour is about an agent's chat — with no agent to open (none remembered, or it is gone), say so instead
    // of opening an empty chat that waits ~3 s and shows nothing.
    const { instances } = appStore.get();
    if (!last || !(instances || []).some((i) => i && i.name === last)) { toast(t("chat.tourNoAgent"), false); return; }
    navigate(chatPath(last));
    // This replay belongs to the navigation it just made — that one, by its sequence number, not by URL (A → B → A, or
    // the same path again, is a new navigation). It did not happen (a leave guard said no) or it is not the chat:
    // nothing. Left meanwhile (another page, another navigation): nothing (#1609 review).
    const nav = navStore.get();
    if (!nav.route || nav.route.panel !== "chat") return;
    const mine = nav.seq;
    const current = () => navStore.get().seq === mine;
    // The tour points at the chat's own controls: start it once the CHAT has drawn — its Send button, not #main (the
    // shell's landmark is on every page, Settings included) — waiting at most ~3 s (#1608 review); a chat that has not
    // drawn by then (its module failed, an unknown instance) gets no tour. The focus goes to the composer first: the
    // tour returns it there when it ends, not to this button, which is gone.
    let tries = 0;
    const go = () => {
      if (!current()) return;
      if (!document.getElementById("sendBtn")) { if (++tries <= 30) setTimeout(go, 100); else toast(t("chat.tourNoAgent"), false); return; }
      const here = document.getElementById("msgIn") || document.getElementById("main");
      if (here && typeof here.focus === "function") here.focus();
      if (current()) startTour();
    };
    setTimeout(go, 0);
  };
  const publicLink = typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1";
  return html`<${ProfileCard} />
  <section class="card s-device s-synced"><h3>${tn("syncedTitle")}</h3>
    <p class="sub">${publicLink ? tn("syncedPublicLink") : tn("syncedLead")}</p>
    <${DevicePrefs} labels=${true} />
    ${P() ? html`<label class="check"><input type="checkbox" checked=${on} onChange=${(e) => { const want = e.target.checked; setPreviewOptIn(want).then(setOn); }} />
      <span>${t("chat.previews")}</span></label>` : null}
  </section>
  <section class="card s-device s-local"><h3>${tn("deviceTitle")}</h3>
    <p class="sub">${tn("deviceLead")}</p>
    <div class="s-device-row"><button type="button" id="tourBtn" class="btn" title=${t("chat.tourBtnTitle")} onClick=${replay}><${Icon} name="info" size=${16} />${t("chat.tour")}</button></div>
  </section>`;
}

/**
 * #1827: who agents see when this person writes from the web. Signed in with a code sent to their Discord or Telegram
 * account, they are that account — its user id, and its name unless they choose another (it follows them to every
 * device, the public link included). Otherwise "web-user", as before. The host checks a name in full and says why it
 * refuses one; this only shows what it says.
 */
const view = (b) => ({ phase: "ready", name: b.name || "", shown: b.shown || "", id: b.id || "", bound: b.bound === true, platform: b.platform_name || "", error: "" });
export function ProfileCard() {
  const [state, setState] = useState({ phase: "loading", name: "", shown: "", id: "", bound: false, platform: "", error: "" });
  const [draft, setDraft] = useState("");
  const lease = useLease();
  useEffect(() => {
    let live = true;
    api("/ui/profile").then((r) => {
      if (!live) return;
      if (!r.ok || !r.body) { setState((s) => ({ ...s, phase: "unavailable" })); return; }
      setState(view(r.body));
      setDraft(r.body.name || "");
    }).catch(() => { if (live) setState((s) => ({ ...s, phase: "unavailable" })); });
    return () => { live = false; };
  }, []);
  if (state.phase === "unavailable") return null;
  const save = (clear) => {
    setState((s) => ({ ...s, phase: "saving", error: "" }));
    api("/ui/profile", { method: "POST", body: JSON.stringify({ name: clear ? null : draft }) }).then((r) => {
      if (lease && !lease.current()) return;
      if (!r.ok) { setState((s) => ({ ...s, phase: "ready", error: (r.body && r.body.error) || tn("profileFailed") })); return; }
      setState(view(r.body));
      setDraft(r.body.name || "");
      toast(tn("profileSaved", r.body.shown || "web-user"));
    }).catch(() => setState((s) => ({ ...s, phase: "ready", error: tn("profileFailed") })));
  };
  const busy = state.phase !== "ready";
  const changed = draft.trim() !== state.name;
  return html`<section class="card s-device s-profile"><h3>${tn("profileTitle")}</h3>
    <p class="sub">${state.bound ? tn("profileLeadBound") : tn("profileLeadUnbound")}</p>
    <div class="field"><label for="profile-name">${tn("profileName")}</label>
      <input id="profile-name" type="text" maxlength="200" autocomplete="nickname" value=${draft} disabled=${busy}
        placeholder=${state.platform || "web-user"} aria-invalid=${state.error ? "true" : "false"} aria-describedby="profile-help"
        onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && changed && draft.trim()) save(false); }} />
      <p class="sub" id="profile-help">${state.error ? html`<span class="err" role="alert">${state.error}</span>` : tn("profileHelp", state.shown || "web-user", state.id)}</p></div>
    <div class="s-device-row"><button type="button" class="btn primary" disabled=${busy || !changed || !draft.trim()} onClick=${() => save(false)}>${tn("profileSave")}</button>
      ${state.name ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => save(true)}>${state.bound ? tn("profileUseAccount", state.platform || "web-user") : tn("profileClear")}</button>` : null}</div>
  </section>`;
}

/** The operation in hand still owns Apply: its writes and job, or a restart of AgEnD from the press to its end. */
const opBusy = (op) => !!op && (["writing", "posting", "watching"].includes(op.phase) || op.restart === "busy");
function dropSecrets(staged) { for (const c of staged.values()) if (c.connectionSecret) c.connectionSecret.secret = ""; }

function renderDialog(d, ctx, close) {
  if (d.kind === "agent") return html`<${AgentDialog} name=${d.name} inst=${d.inst} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "bot") return html`<${BotDialog} key=${d.id} id=${d.id} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "newBot") return html`<${NewBotDialog} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "classic") return html`<${ClassicDialog} room=${d.room} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "create") return html`<${CreateInstanceDialog} onClose=${() => { close(); ctx.reload(); }} />`;
  if (d.kind === "wizard") return html`<${SetupWizard} ctx=${ctx} onClose=${close} />`;
  return null;
}

/** What the sections and dialogs work with: the data, and the ways to change it (staging, or a direct write). */
function makeCtx(data, setData, stage, unstage, reload, reloadLive, alive, extra = {}) {
  const { fleet, classic, schema } = data;
  const chs = channelsOf(fleet);
  const edit = (fn) => setData((d) => { const next = structuredClone(d); fn(next); return next; });
  return {
    ...data, ...extra, reload, reloadLive, stage, unstage, shortName,
    channelType: (id) => { const ch = chs.find((c, i) => channelId(c, i) === id); return ch ? ch.type : undefined; },
    classicRuntime: (instanceName) => {
      const live = data.classicLive[instanceName] || {};
      const status = live.status || data.classicStatus[instanceName] || "stopped";
      return { status, execution: status === "paused" ? "paused" : (live.state || status) };
    },
    stageAgent(name, inst, patch) {
      edit((d) => {
        const next = { ...inst, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
        if (patch.hang_detector && patch.hang_detector.timeout_minutes === null) {
          next.hang_detector = { ...(inst.hang_detector || {}) };
          delete next.hang_detector.timeout_minutes;
        }
        d.fleet.instances[name] = next;
      });
      stage(`agent:${name}`, {
        label: tn("updateAgent", shortName(name, { ...inst, ...patch })),
        impact: batchImpact(schema, Object.keys(patch), (k) => impactOf(schema, `instance.${k}`)),
        request: { method: "PATCH", url: `/api/settings/fleet/instances/${encodeURIComponent(name)}`, body: patch },
      });
    },
    async deleteAgent(name) {
      if (!(await ask(tn("deleteAgent", name), { confirmLabel: tn("deleteAgentMenu"), danger: true }))) return;
      if (!alive()) return;                          // the panel went while it asked: nothing staged, nothing said
      edit((d) => { delete d.fleet.instances[name]; });
      stage(`agent:${name}`, { label: tn("deleteAgentLabel", name), impact: impactOf(schema, "instance.delete"),
        request: { method: "DELETE", url: `/api/settings/fleet/instances/${encodeURIComponent(name)}` } });
    },
    stageChannels(key, nextChannels, meta) {
      edit((d) => { d.fleet.channels = nextChannels; delete d.fleet.channel; });
      stage(key, { ...meta, request: { method: "PUT", url: "/api/settings/fleet/channels", body: nextChannels } });
    },
    stageClassic(c, patch) {
      edit((d) => {
        const room = { ...d.classic.channels[c.key], ...patch };
        for (const k of ["model", "auto_pause_after", "tool_progress", "reply_completion_guard"]) if (patch[k] === null) delete room[k];
        d.classic.channels[c.key] = room;
      });
      const hotOnly = Object.keys(patch).every((k) => impactOf(schema, `classic.${k}`) === "now");
      stage(`classic:${c.key}`, { label: tn("updateAgent", c.name || c.instanceName), impact: hotOnly ? "now" : "instance",
        request: { method: "PATCH", url: `/api/settings/classic/channels/${encodeURIComponent(c.key)}`, body: patch } });
    },
    async pauseWake(name, action) {
      const res = await api(`/api/settings/instances/${encodeURIComponent(name)}/${action}`, { method: "POST" }).catch(() => ({ ok: false, body: {} }));
      if (!res.ok) toast((res.body && res.body.error) || tn("actionFailed", action), false);
      else if (res.body && res.body.held) toast(res.body.message);
      await reloadLive();
    },
    async startStop(name, running) {
      const res = await api(running ? `/stop/${encodeURIComponent(name)}` : `/api/instance/${encodeURIComponent(name)}/start`, { method: "POST" }).catch(() => ({ ok: false, body: {} }));
      if (!res.ok) toast(`${tn("actionFailed", running ? tn("stop") : tn("start"))}: ${(res.body && res.body.error) || res.status || ""}`, false);
      else if (res.body && res.body.held) toast(res.body.message);
      await new Promise((r) => setTimeout(r, 800));
      await reloadLive();
    },
    classic: classic || {},
  };
}

// ── Sections ──

const STATUS_KEY = { running: "stRunning", paused: "stPaused", crashed: "stCrashed", stopped: "stStopped" };
const dotClass = (st) => `dot ${st === "running" || st === "idle" ? "ok" : st === "crashed" || st === "stuck" ? "bad" : st === "working" ? "busy" : "off"}`;

function agentChannelLabel(inst, chs) {
  if (inst.general_topic) return "general";
  if (!inst.channel_id) return "";
  const idx = chs.findIndex((c, i) => channelId(c, i) === inst.channel_id);
  return idx >= 0 ? `${chs[idx].type} (${chLabel(idx)})` : inst.channel_id;
}

function Agents({ ctx, search, openDialog }) {
  const insts = ctx.fleet.instances || {};
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [busy, setBusy] = useState(() => new Map());     // name → the action under way
  const chs = channelsOf(ctx.fleet);
  // #2172: the sidebar's grouping — an agent in a team under its team, else under its first tag.
  const teamsOf = (name) => Object.keys(ctx.fleet.teams || {}).filter((t) => Array.isArray(ctx.fleet.teams[t]?.members) && ctx.fleet.teams[t].members.includes(name));
  const groups = groupAgents(insts, ctx.live, search, (name) => navGroupOf({ tags: insts[name]?.tags, teams: teamsOf(name) }), groupLabel);
  // One action per agent at a time: the whole row is off (Settings and ⋯ too), and the pressed button says it is working.
  const run = async (name, action, work) => {
    if (busy.has(name)) return;
    setBusy((b) => new Map(b).set(name, action));
    try { await work(); } finally { setBusy((b) => { const n = new Map(b); n.delete(name); return n; }); }
  };
  const head = html`<div class="list-head"><span>${Object.keys(insts).length === 1 ? tn("countAgent") : tn("countAgents", Object.keys(insts).length)}</span>
    <button type="button" class="btn btn-primary" onClick=${() => openDialog({ kind: "create" })}><${Icon} name="plus" size=${16} />${tn("newAgent")}</button></div>`;
  // #2233: after the agents, each login on this machine with Sign in (backend-signin.js).
  const signIns = html`<${SignInList} />`;
  if (!Object.keys(insts).length) return html`${head}<${Empty} icon="bot" title=${tn("noAgents")} />${signIns}`;
  if (!groups.length) return html`${head}<${Empty} icon="search" title=${tn("noAgentMatch", search.trim())} />${signIns}`;
  return html`${head}<div class="s-list">${groups.map(({ group, names }) => {
    const folded = collapsed.has(group) && !search.trim();      // searching opens every group
    return html`<section key=${group} class="s-group">
      <button type="button" class="s-group-head" aria-expanded=${folded ? "false" : "true"}
        onClick=${() => setCollapsed((c) => { const n = new Set(c); n.has(group) ? n.delete(group) : n.add(group); return n; })}>
        <${Icon} name="chevron" size=${14} cls=${folded ? "caret folded" : "caret"} /><${GroupMark} group=${group} /><span class="grow">${groupLabel(group)}</span><span class="count">${names.length}</span></button>
      ${folded ? null : names.map((name) => {
        const inst = insts[name];
        const st = (ctx.live[name] && ctx.live[name].status) || "stopped";
        const sum = effectiveSummary(ctx.live[name] || {}, inst, ctx.fleet.defaults || {});
        const ch = agentChannelLabel(inst, chs);
        const working = busy.has(name), doing = busy.get(name);
        const label = (action, text) => (doing === action ? tn("working") : text);
        return html`<div key=${name} class="s-row">
          <span class=${dotClass(st)} title=${tn(STATUS_KEY[st] || "stStopped")} aria-hidden="true"></span>
          <span class="s-name" title=${name}>${shortName(name, inst)}</span>
          <span class="s-meta" title=${sum.backend}>${sum.model}</span>
          <span class="s-br" aria-hidden="true"></span>
          <span class="tag">${tn("effortTag", sum.effort)}</span>
          ${ch ? html`<span class=${`tag${ch.includes("persona") ? " persona" : ""}`}>${ch}</span>` : null}
          <span class="sr-only">${tn(STATUS_KEY[st] || "stStopped")}</span>
          <span class="s-actions">
            <button type="button" class="btn btn-sm" disabled=${working} onClick=${() => openDialog({ kind: "agent", name, inst })}>${tn("settingsButton")}</button>
            ${st === "running" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "pause", () => ctx.pauseWake(name, "pause"))}>${label("pause", tn("pause"))}</button>` : null}
            ${st === "paused" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "wake", () => ctx.pauseWake(name, "wake"))}>${label("wake", tn("wake"))}</button>` : null}
            ${st !== "paused" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "startStop", () => ctx.startStop(name, st === "running"))}>${label("startStop", st === "running" ? tn("stop") : tn("start"))}</button>` : null}
            <${Menu} label=${t("app.more")} items=${[{ key: "delete", label: tn("deleteAgentMenu"), icon: "trash", danger: true, disabled: working, onSelect: () => ctx.deleteAgent(name) }]} />
          </span>
        </div>`;
      })}
    </section>`;
  })}</div>${signIns}`;
}

function ConnectionRetry({ id, ctx }) {
  const lease = useLease(`connection-retry:${id}`);
  const claimed = useRef(false);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    if (claimed.current) return;
    claimed.current = true; setBusy(true);
    try {
      const response = await lease.fetch(`/api/settings/connections/${encodeURIComponent(id)}/retry`, { method: "POST" });
      if (!lease.current()) return;
      toast(response.ok ? tn("connRetryQueued") : tn("connRetryFailed"));
      await ctx.reload();
    } catch {
      if (lease.current()) toast(tn("connRetryFailed"));
    } finally {
      claimed.current = false;
      if (lease.current()) setBusy(false);
    }
  };
  return html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${retry}>${tn("connRetryNow")}</button>`;
}

function Bots({ ctx, search, openDialog }) {
  const overPublicLink = globalThis.document?.body?.dataset?.publicLink === "1";
  const all = channelsOf(ctx.fleet);
  const needle = search.trim().toLowerCase();
  const rows = all.map((ch, i) => ({ ch, i })).filter(({ ch }) => !needle || [ch.id, ch.type, ch.group_id, ch.bot_token_env].some((v) => String(v ?? "").toLowerCase().includes(needle)));
  const head = html`<div class="list-head"><span>${all.length === 1 ? tn("countBot") : tn("countBots", all.length)}</span>
    <button type="button" class="btn btn-primary" onClick=${() => openDialog({ kind: "newBot" })}><${Icon} name="plus" size=${16} />${tn("newBot")}</button></div>`;
  return html`${head}
    ${!rows.length ? html`<${Empty} icon="plug" title=${needle ? tn("noAgentMatch", search.trim()) : tn("noBots")} />` : html`<div class="s-list">${rows.map(({ ch, i }) => {
      const users = (ch.access && ch.access.allowed_users) || [];
      const meta = ctx.connections.find((c, j) => channelId(c, j) === channelId(ch, i)) || {};
      const token = meta.token_present;
      // #1519 P6: this connection's own state (not the fleet's "Connected") — a stopped one says so; a known problem says
      // what to do (P3: Message Content intent; a rejected token).
      const state = connectionState(meta, ctx.fleetUp);
      const stateText = tn(state.key, state.bot);
      // #1408 step 5: one line on a desktop — who it is, its facts in one clipped line (all of them in its tooltip),
      // then the cluster; on a phone the facts go under it. It no longer wraps fact by fact.
      const facts = [ch.bot_token_env || tn("noTokenEnv"),
        ch.group_id ? (ch.type === "telegram" ? tn("groupTag", ch.group_id) : tn("guildTag", ch.group_id)) : null,
        tn("accessTag", (ch.access && ch.access.mode) || "locked"),
        users.length ? `${users.slice(0, 3).join(", ")}${users.length > 3 ? ` +${users.length - 3}` : ""}` : tn("noAllowedUsers")].filter(Boolean).join(" · ");
      return html`<div key=${channelId(ch, i)} class="s-row s-conn">
        <span class="s-ident"><span class=${`dot ${state.cls}`} title=${stateText} aria-hidden="true"></span>
          <span class="s-name">${ch.type === "telegram" ? "Telegram" : "Discord"}</span>
          <span class=${`tag${i === 0 ? "" : " persona"}`}>${ch.id || chLabel(i)}</span></span>
        <span class="s-facts" title=${facts}>${facts}</span>
        <span class="s-actions">
          <span class=${`tag${token ? "" : " warn"}`}>${token ? tn("tokenConfigured") : tn("tokenMissing")}</span>
          <span class=${`s-state ${state.cls}`} title=${stateText}>${stateText}</span>
          ${!overPublicLink && ctx.fleetUp && meta.status !== "connected" ? html`<${ConnectionRetry} id=${channelId(ch, i)} ctx=${ctx} />` : null}
          <button type="button" class="btn btn-sm" onClick=${() => openDialog({ kind: "bot", id: channelId(ch, i) })}>${tn("settingsButton")}</button></span>
      </div>`;
    })}</div>`}
    ${ctx.providerOk ? html`<${ProviderKeys} ctx=${ctx} />` : null}`;
}

/**
 * Provider API keys: verified by AgEnD, then applied (it may need an admin's confirmation, #1423). A provider whose
 * key cannot be positively verified gets no input at all — never an "unverified" write.
 */
function ProviderKeys({ ctx }) {
  // Its own lease: a section change unmounts this card, and a verification started here that answers after that is
  // abandoned before its apply — never applied over a key entered since (#1453 review). A write already sent is not
  // undone; it is followed to its end on the server.
  const lease = useLease("provider-keys");
  const [keys, setKeys] = useState({});
  const [notes, setNotes] = useState({});
  // One request per provider at a time, each owning only its own provider's busy state (#1453 review): a second
  // provider's key never unlocks the first while the first is still on its way. The ref decides at once; the state
  // only draws it.
  const inFlight = useRef(new Set());
  const [busy, setBusy] = useState(() => new Set());
  const say = (id, note) => { if (lease.current()) setNotes((n) => ({ ...n, [id]: note })); };
  const go = async (spec) => {
    const secret = keys[spec.id] || "";
    if (!secret) { say(spec.id, { error: tn("enterKeyFirst") }); return; }
    if (inFlight.current.has(spec.id)) return;
    inFlight.current.add(spec.id);
    setBusy(new Set(inFlight.current));
    setKeys((k) => ({ ...k, [spec.id]: "" }));                 // out of the form at once; only this request holds it
    say(spec.id, { text: tn("verifying") });
    const key = newKey("provider");
    const base = `/api/settings/secrets/${encodeURIComponent(spec.id)}`;
    try {
      const verified = await api(`${base}/verify`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ secret, idempotency_key: key }) });
      if (!lease.current()) return;
      if (!verified.ok) { say(spec.id, { error: (verified.body && verified.body.error) || tn("verifyFailed") }); return; }
      say(spec.id, { text: tn("applyingKey") });
      const result = await confirmedWrite(`${base}/apply`, { method: "POST", key, label: tn("providerKeyLabel", spec.display_name),
        body: { verification_id: verified.body && verified.body.verification_id, idempotency_key: key } });
      let body = result.body || {};
      for (let n = 0; result.ok && body.job_id && body.result === "applying" && n < 60; n++) {
        await new Promise((r) => setTimeout(r, 250));
        const status = await api(`${base}/apply/${encodeURIComponent(body.job_id)}`).catch(() => null);
        if (status && status.ok) body = status.body || body;
      }
      const labels = { applied_next_use: "keyAppliedNextUse", reloaded: "keyApplied", rolled_back: "keyRolledBack", rollback_failed: "keyRollbackFailed" };
      const ok = body.result === "applied_next_use" || body.result === "reloaded";
      say(spec.id, ok ? { text: tn(labels[body.result]) } : { error: labels[body.result] ? tn(labels[body.result]) : (body.error || tn("applyFailed")) });
      if (ok && lease.current()) ctx.reload();
    } catch { say(spec.id, { error: tn("failed") }); }
    finally { inFlight.current.delete(spec.id); if (lease.current()) setBusy(new Set(inFlight.current)); }
  };
  return html`<section class="card"><h3>${tn("providerKeys")}</h3>
    ${!ctx.providerSecrets.length ? html`<p class="note">${tn("noProviderVerifiers")}</p>` : ctx.providerSecrets.map((spec) => html`<div key=${spec.id} class="s-key">
      <div class="s-key-row"><strong>${spec.display_name}</strong><span class="tag">${spec.token_present ? tn("keyConfigured") : tn("keyNotConfigured")}</span>
        ${spec.verifier === "available" ? html`<input type="password" autocomplete="new-password" aria-label=${tn("providerKeyInput", spec.display_name)}
            placeholder=${spec.token_present ? tn("keyConfigured") : tn("keyNotConfigured")} value=${keys[spec.id] || ""} onInput=${(e) => setKeys((k) => ({ ...k, [spec.id]: e.target.value }))} />
          <button type="button" class="btn btn-sm btn-primary" disabled=${busy.has(spec.id)} onClick=${() => go(spec)}>${tn("verifyApply")}</button>`
          : html`<span class="tag">${tn("unsupportedVerifier")}</span>`}</div>
      ${spec.verifier === "available" ? null : html`<p class="note">${tn("unsupportedVerifierHint")}</p>`}
      ${notes[spec.id] ? html`<p class=${`feedback${notes[spec.id].error ? " error" : ""}`} role="status">${notes[spec.id].error || notes[spec.id].text}</p>` : null}
    </div>`)}
  </section>`;
}

function Classic({ ctx, search, openDialog }) {
  const rooms = Object.entries((ctx.classic && ctx.classic.channels) || {}).map(([key, ch]) => ({ key, ...ch }));
  if (!rooms.length) return html`<${Empty} icon="room" title=${tn("noClassic")} />`;
  const needle = search.trim().toLowerCase();
  const list = rooms.filter((c) => !needle || String(c.name || "").toLowerCase().includes(needle) || String(c.instanceName || "").toLowerCase().includes(needle))
    .sort((a, b) => ((STATUS_ORDER[ctx.classicRuntime(a.instanceName).status] ?? 9) - (STATUS_ORDER[ctx.classicRuntime(b.instanceName).status] ?? 9))
      || String(a.name || "").localeCompare(String(b.name || "")));
  if (!list.length) return html`<${Empty} icon="search" title=${tn("noAgentMatch", search.trim())} />`;
  return html`<div class="list-head"><span>${rooms.length === 1 ? tn("countRoom") : tn("countRooms", rooms.length)}</span></div><div class="s-list">${list.map((c) => {
    const rt = ctx.classicRuntime(c.instanceName);
    const sum = effectiveSummary(ctx.live[c.instanceName] || {}, c, ctx.fleet.defaults || {}, (ctx.classic && ctx.classic.defaults) || {});
    const adapter = c.adapterId || "discord";
    return html`<div key=${c.key} class="s-row">
      <span class=${dotClass(rt.execution)} title=${tn(`exec_${rt.execution}`)} aria-hidden="true"></span>
      <span class="s-name" title=${c.instanceName || ""}>${shortName(c.name || c.instanceName || "?", { display_name: c.display_name })}</span>
      <span class="s-meta" title=${sum.backend}>${sum.model}</span>
      <span class="s-br" aria-hidden="true"></span>
      <span class="tag">${tn("effortTag", sum.effort)}</span>
      <span class=${`tag${adapter !== "discord" ? " persona" : ""}`}>${adapter}</span>
      ${c.collab ? html`<span class="tag">collab</span>` : null}
      <span class="tag">${tn(`exec_${rt.execution}`)}</span>
      <span class="s-actions">
        <button type="button" class="btn btn-sm" onClick=${() => openDialog({ kind: "classic", room: c })}>${tn("settingsButton")}</button>
        ${rt.status === "running" ? html`<button type="button" class="btn btn-sm" onClick=${() => ctx.pauseWake(c.instanceName, "pause")}>${tn("pause")}</button>` : null}
        ${rt.status === "paused" ? html`<button type="button" class="btn btn-sm" onClick=${() => ctx.pauseWake(c.instanceName, "wake")}>${tn("wake")}</button>` : null}
      </span>
    </div>`;
  })}</div>`;
}

/** General's form, from the saved defaults (`d`) and ClassicBot's (`c`). */
function generalForm(d, c) {
  const hang = d.hang_detector || {}, startup = d.startup || {};
  return {
    backend: d.backend || "claude-code", model: d.model || "", locale: d.locale || "", auto: String(d.auto_pause_after ?? 0),
    agent_mode: d.agent_mode || "mcp", tool_set: d.tool_set || "full", tool_progress: d.tool_progress ?? "off",
    visibility: visibilityDefault(d), reply: d.reply_completion_guard ?? true, log_level: d.log_level || "info",
    hangOn: hang.enabled !== false, hang: String(hang.timeout_minutes ?? HANG_TIMEOUT_DEFAULT_MINUTES),
    concurrency: String(startup.concurrency ?? 10), stagger: String(startup.stagger_delay_ms ?? 500),
    classicBackend: c.backend || d.backend || "claude-code",
    classicToolProgress: c.tool_progress ?? d.tool_progress ?? "off", classicToolProgressInherit: !hasOwn(c, "tool_progress"),
    classicReply: c.reply_completion_guard ?? d.reply_completion_guard ?? true, classicReplyInherit: !hasOwn(c, "reply_completion_guard"),
    admins: [...(c.admin_users || [])], guilds: [...(c.allowed_guilds || [])],
  };
}

/**
 * General: the fleet's defaults and ClassicBot's. #2347: an edit is unsaved at once — staged (up to two changes:
 * defaults, ClassicBot defaults), each only with what differs from what is saved, so changing one hot default never also
 * stages untouched settings as a fleet restart; the sticky bar saves them. A changed field carries the straight bar.
 */
function General({ ctx }) {
  const { schema } = ctx;
  const d = ctx.fleet.defaults || {}, c = (ctx.classic && ctx.classic.defaults) || {};
  const hang = d.hang_detector || {}, startup = d.startup || {};
  const primary = channelsOf(ctx.fleet)[0];
  const original = useMemo(() => ({ c: structuredClone(c) }), []);
  const base = useMemo(() => generalForm(d, c), []);
  const [f, setF] = useDraft(ctx, "general", () => base);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  /** The class of a field's row: `field`, and `s-dirty` while one of its keys differs from what is saved. */
  const fc = (cls, ...keys) => `${cls}${keys.some((k) => !sameValue(f[k], base[k])) ? " s-dirty" : ""}`;
  const num = (v) => Number(v);
  const errors = {
    auto: nonNegative(f.auto), hang: positive(f.hang),
    concurrency: !Number.isInteger(num(f.concurrency)) || num(f.concurrency) < 1 || num(f.concurrency) > 20 ? "concurrencyRange" : "",
    stagger: !Number.isFinite(num(f.stagger)) || f.stagger.trim() === "" || num(f.stagger) < 0 || num(f.stagger) > 30000 ? "staggerRange" : "",
  };
  const warnings = { concurrency: num(f.concurrency) > 4 ? "concurrencyWarning" : "", stagger: num(f.stagger) < 100 ? "staggerWarning" : "" };
  const ready = !Object.values(errors).some(Boolean);
  const firstError = Object.values(errors).find(Boolean);
  // #2347: every edit, staged as it is made (the first render included: a draft kept from before is staged again).
  useEffect(() => {
    if (ctx.readOnly) return;
    if (!ready) {
      syncStage(ctx, "defaults:invalid", { label: tn("updateDefaults"), invalid: tn(firstError) });
      return;
    }
    ctx.unstage("defaults:invalid");
    const defaultsPatch = changedFields({
      backend: f.backend, model: f.model || undefined, locale: f.locale || null, auto_pause_after: num(f.auto),
      agent_mode: f.agent_mode, tool_set: f.tool_set, tool_progress: f.tool_progress, cross_instance_visibility: f.visibility,
      reply_completion_guard: f.reply, log_level: f.log_level,
      hang_detector: { enabled: f.hangOn, timeout_minutes: num(f.hang) },
      startup: { concurrency: num(f.concurrency), stagger_delay_ms: num(f.stagger) },
    }, {
      backend: d.backend || "claude-code", model: d.model || undefined, locale: d.locale || null, auto_pause_after: d.auto_pause_after ?? 0,
      agent_mode: d.agent_mode || "mcp", tool_set: d.tool_set || "full", tool_progress: d.tool_progress ?? "off",
      cross_instance_visibility: visibilityDefault(d), reply_completion_guard: d.reply_completion_guard ?? true, log_level: d.log_level || "info",
      hang_detector: { enabled: hang.enabled !== false, timeout_minutes: hang.timeout_minutes ?? HANG_TIMEOUT_DEFAULT_MINUTES },
      startup: { concurrency: startup.concurrency ?? 10, stagger_delay_ms: startup.stagger_delay_ms ?? 500 },
    });
    const oc = original.c;
    const classicPatch = changedFields({
      backend: f.classicBackend,
      tool_progress: f.classicToolProgressInherit ? null : f.classicToolProgress,
      reply_completion_guard: f.classicReplyInherit ? null : f.classicReply,
      admin_users: f.admins, allowed_guilds: f.guilds,
    }, {
      backend: oc.backend || d.backend || "claude-code",
      tool_progress: hasOwn(oc, "tool_progress") ? oc.tool_progress : null,
      reply_completion_guard: hasOwn(oc, "reply_completion_guard") ? oc.reply_completion_guard : null,
      admin_users: oc.admin_users || [], allowed_guilds: oc.allowed_guilds || [],
    });
    const dKeys = Object.keys(defaultsPatch), cKeys = Object.keys(classicPatch);
    syncStage(ctx, "defaults:fleet", dKeys.length ? { label: tn("updateDefaults"), count: dKeys.length,
      impact: batchImpact(schema, dKeys, (k) => defaultsImpact(schema, k)),
      request: { method: "PUT", url: "/api/settings/fleet/defaults", body: defaultsPatch } } : null);
    syncStage(ctx, "defaults:classic", cKeys.length ? { label: tn("updateClassicDefaults"), count: cKeys.length,
      impact: cKeys.every((k) => impactOf(schema, `classic_defaults.${k}`) === "now") ? "now" : "fleet",
      request: { method: "PUT", url: "/api/settings/classic/defaults", body: classicPatch } } : null);
  }, [f, ready]);
  const L = (text, field, id) => html`<${Label} text=${text} schema=${schema} field=${field} htmlFor=${id} />`;
  const fleetReply = replyGuardSupported(f.backend, f.agent_mode, d.kiro_ui) ? tn("replyGuardSupported") : tn("replyGuardUnsupported", f.backend, f.agent_mode);
  const classicReply = replyGuardSupported(f.classicBackend, f.agent_mode, d.kiro_ui) ? tn("replyGuardSupported") : tn("replyGuardUnsupported", f.classicBackend, f.agent_mode);
  return html`<div class="form s-general">
    <section class="card"><h3>${tn("defaultsTitle")}</h3>
      <div class="grid2">
        <div class=${fc("field", "locale")}>${L(tn("language"), "defaults.locale", "g-locale")}<${Select} id="g-locale" value=${f.locale} onChange=${set("locale")}
          options=${localeOptions(f.locale).map((o) => (o.auto ? { value: "", label: tn("localeAuto") } : o))} /></div>
        <div class=${fc("field", "backend")}>${L(tn("defaultBackend"), "defaults.backend", "g-be")}<${BackendSelect} id="g-be" value=${f.backend} onChange=${set("backend")} /></div>
        <div class=${fc("field", "model")}>${L(tn("defaultModel"), "defaults.model", "g-model")}<${ModelSelect} id="g-model" value=${f.model} onChange=${set("model")}
          backend=${f.backend || "claude-code"} inherit=${tn("modelCliDefault")} /></div>
        <div class=${fc("field", "auto")}>${L(`${tn("autoPause")} (${tn("minutes")})`, "defaults.auto_pause_after", "g-auto")}<input id="g-auto" type="number" min="0" step="1" class=${errors.auto ? "invalid" : ""} value=${f.auto} onInput=${(e) => set("auto")(e.target.value)} /><${Feedback} error=${errors.auto} /></div>
        <div class=${fc("field", "tool_progress")}>${L(tn("toolProgress"), "defaults.tool_progress", "g-tp")}<${Select} id="g-tp" value=${f.tool_progress} onChange=${set("tool_progress")} options=${TOOL_PROGRESS} /></div>
        <div class=${fc("field", "visibility")}>${L(tn("crossInstanceVisibility"), "defaults.cross_instance_visibility", "g-vis")}<${Select} id="g-vis" value=${f.visibility} onChange=${set("visibility")} options=${VISIBILITY_MODES} />
          <p class="note">${tn("crossInstanceVisibilityHint")}</p></div>
        <div class=${fc("field", "reply")}><label class="check"><input type="checkbox" checked=${f.reply} onChange=${(e) => set("reply")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span><${Impact} schema=${schema} field="defaults.reply_completion_guard" /></label>
          <p class="note">${fleetReply}</p></div>
      </div>
    </section>
    <section class="card"><h3>ClassicBot</h3>
      <div class="grid2">
        <div class=${fc("field", "classicBackend")}>${L(tn("classicBackend"), "classic_defaults.backend", "g-cbe")}<${BackendSelect} id="g-cbe" value=${f.classicBackend} onChange=${set("classicBackend")} /></div>
        <div class=${fc("field", "classicToolProgress", "classicToolProgressInherit")}>${L(tn("toolProgress"), "classic_defaults.tool_progress", "g-ctp")}
          <${Override} inherit=${f.classicToolProgressInherit} onInherit=${set("classicToolProgressInherit")}>
            <${Select} id="g-ctp" disabled=${f.classicToolProgressInherit} value=${f.classicToolProgressInherit ? (d.tool_progress ?? "off") : f.classicToolProgress} onChange=${set("classicToolProgress")} options=${TOOL_PROGRESS} /></${Override}></div>
        <div class=${fc("field", "classicReply", "classicReplyInherit")}>${L(tn("replyCompletionGuard"), "classic_defaults.reply_completion_guard")}
          <${Override} inherit=${f.classicReplyInherit} onInherit=${set("classicReplyInherit")}>
            <label class="check"><input type="checkbox" disabled=${f.classicReplyInherit} checked=${f.classicReplyInherit ? (d.reply_completion_guard ?? true) : f.classicReply} onChange=${(e) => set("classicReply")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span></label></${Override}>
          <p class="note">${classicReply}</p></div>
      </div>
      <h4>${tn("whoUsesClassic")}</h4>
      <div class="grid2">
        <div class=${fc("field", "admins")}>${L(tn("classicAdmins"), "classic.admin_users")}<${ChipList} items=${f.admins} onChange=${set("admins")} placeholder=${tn("userIdPlaceholder")} label=${tn("classicAdmins")} /></div>
        <div class=${fc("field", "guilds")}>${L(tn("allowedGuilds"), "classic.allowed_guilds")}<${ChipList} items=${f.guilds} onChange=${set("guilds")} placeholder=${tn("guildIdPlaceholder")} label=${tn("allowedGuilds")} /></div>
      </div>
    </section>
    <${Drawer} title=${tn("advancedSection")}>
      <section class="card"><h3>${tn("runtimeResources")}</h3><div class="grid2">
        <div class=${fc("field", "tool_set")}>${L(tn("toolSet"), "defaults.tool_set", "g-ts")}<${Select} id="g-ts" value=${f.tool_set} onChange=${set("tool_set")} options=${TOOL_SETS} /></div>
        <div class=${fc("field", "log_level")}>${L(tn("logLevel"), "defaults.log_level", "g-ll")}<${Select} id="g-ll" value=${f.log_level} onChange=${set("log_level")} options=${LOG_LEVELS} /></div>
        <div class=${fc("field", "agent_mode")}>${L(tn("agentMode"), "defaults.agent_mode", "g-am")}<${Select} id="g-am" value=${f.agent_mode} onChange=${set("agent_mode")} options=${AGENT_MODES} /></div>
      </div></section>
      <section class="card"><h3>${tn("detection")}</h3><div class="grid2">
        <label class=${fc("check", "hangOn")}><input type="checkbox" checked=${f.hangOn} onChange=${(e) => set("hangOn")(e.target.checked)} /><span>${tn("hangEnabled")}</span><${Impact} schema=${schema} field="defaults.hang_detector" /></label>
        <div class=${fc("field", "hang")}>${L(`${tn("hangTimeout")} (${tn("minutes")})`, "defaults.hang_detector", "g-hang")}<input id="g-hang" type="number" min="0.1" step="0.5" class=${errors.hang ? "invalid" : ""} value=${f.hang} onInput=${(e) => set("hang")(e.target.value)} /><${Feedback} error=${errors.hang} /></div>
      </div></section>
      <section class="card"><h3>${tn("startup")}</h3><div class="grid2">
        <div class=${fc("field", "concurrency")}>${L(tn("concurrency"), "fleet.spawn_concurrency", "g-conc")}<input id="g-conc" type="number" min="1" max="20" step="1" class=${errors.concurrency ? "invalid" : ""} value=${f.concurrency} onInput=${(e) => set("concurrency")(e.target.value)} /><${Feedback} error=${errors.concurrency} warning=${warnings.concurrency} /></div>
        <div class=${fc("field", "stagger")}>${L(`${tn("staggerDelay")} (ms)`, "fleet.spawn_stagger_ms", "g-stag")}<input id="g-stag" type="number" min="0" max="30000" step="100" class=${errors.stagger ? "invalid" : ""} value=${f.stagger} onInput=${(e) => set("stagger")(e.target.value)} /><${Feedback} error=${errors.stagger} warning=${warnings.stagger} /></div>
      </div></section>
      <section class="card"><h3>${tn("accessTitle")}</h3>
        <p class="note">${primary ? tn("accessMovedHint", primary.id || chLabel(0)) : tn("noBots")}</p></section>
    </${Drawer}>
  </div>`;
}

/**
 * #1620: Settings → Web — the dashboard's own settings, in one write (PUT /api/settings/fleet/web). Editable: the local
 * session limits, the browser terminal (on/off, its minutes), web echo and the public link's menu; everything else
 * under web: / web_terminal: is listed read-only (it decides what the dashboard listens on and exposes: fleet.yaml, then
 * agend reload). The server judges each change: loosening one waits for a fleet admin in General, tightening applies at
 * once. Over
 * the temporary public link none of it can be changed — the form says so and stays disabled (the server refuses too).
 */
export const WEB_READ_ONLY = [
  "web.allowed_hosts", "web.view_access", "web.notify_login", "web.preview", "web.preview_port", "web.preview_origin", "web.preview_on_public_link",
  "web.usage_panel", "web.provider_secrets", "web.upload_max_file_mb", "web.upload_max_total_mb", "web_terminal.bind", "web_terminal.tunnel",
];
function WebSection({ ctx, staged }) {
  const { schema } = ctx;
  const web = ctx.fleet.web || {}, local = (web.session && web.session.local) || {}, term = ctx.fleet.web_terminal || {};
  // Over the public link the fields read only; the Guests and Web authority cards are not offered (the server never
  // serves their reads there).
  const overPublicLink = globalThis.document?.body?.dataset?.publicLink === "1";
  const original = useMemo(() => ({
    echo: web.echo_to_channel ?? true,
    log: web.log_tab === true,                                                  // #1218: off by default
    usagePub: web.usage_report_on_public_link === true,                         // #2122: off by default
    pub: { allow_public: (web.public_link && web.public_link.allow_public) ?? true, ttl_minutes: (web.public_link && web.public_link.ttl_minutes) ?? 120, protocol: (web.public_link && web.public_link.protocol) ?? "http2", hostname: (web.public_link && web.public_link.hostname) ?? "", tunnel_token_env: (web.public_link && web.public_link.tunnel_token_env) ?? "", origin_port: (web.public_link && web.public_link.origin_port) ?? 19282 },
    session: { absolute_hours: local.absolute_hours ?? null, idle_hours: local.idle_hours ?? null },
    terminal: { enabled: term.enabled ?? null, ttl_minutes: term.ttl_minutes ?? null },
  }), []);
  const text = (v) => (v === null || v === undefined ? "" : String(v));
  /** #2347: a field's row class: `s-dirty` while it differs from what is saved (the draft may come from before). */
  const savedForm = useMemo(() => ({ echo: original.echo, log: original.log, usagePub: original.usagePub, pub: original.pub.allow_public,
    ttl: String(original.pub.ttl_minutes), protocol: original.pub.protocol, hostname: original.pub.hostname, originPort: String(original.pub.origin_port),
    abs: text(original.session.absolute_hours), idle: text(original.session.idle_hours), termOn: original.terminal.enabled !== false,
    termTtl: text(original.terminal.ttl_minutes) }), []);
  const [f, setF] = useDraft(ctx, "web", () => savedForm, () => {
    // Settings sections share one draft. Reopening Web must show it as well as preserve it in the Apply bar, so a
    // subsequent field edit keeps earlier edits. The original disk values remain the diff/confirmation baseline.
    const request = staged.get("web")?.request;
    const pending = request?.method === "PUT" && request.url === "/api/settings/fleet/web" ? request.body || {} : {};
    const pub = pending.public_link || {}, session = pending.session?.local || {}, terminal = pending.web_terminal || {};
    const pick = (obj, key, fallback) => Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
    return {
      echo: pick(pending, "echo_to_channel", original.echo), log: pick(pending, "log_tab", original.log), usagePub: pick(pending, "usage_report_on_public_link", original.usagePub),
      pub: pick(pub, "allow_public", original.pub.allow_public), ttl: String(pick(pub, "ttl_minutes", original.pub.ttl_minutes)), protocol: pick(pub, "protocol", original.pub.protocol),
      hostname: pick(pub, "hostname", original.pub.hostname), originPort: String(pick(pub, "origin_port", original.pub.origin_port)),
      abs: text(pick(session, "absolute_hours", original.session.absolute_hours)), idle: text(pick(session, "idle_hours", original.session.idle_hours)),
      termOn: pick(terminal, "enabled", original.terminal.enabled) !== false, termTtl: text(pick(terminal, "ttl_minutes", original.terminal.ttl_minutes)),
    };
  });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const fc = (cls, ...keys) => `${cls}${keys.some((k) => !sameValue(f[k], savedForm[k])) ? " s-dirty" : ""}`;
  // Empty = the default (null in the write: the key is removed from fleet.yaml).
  const value = (v) => (v.trim() === "" ? null : Number(v));
  const hours = (v) => { const n = value(v); return n !== null && (!Number.isFinite(n) || n < 1 || n > 720) ? "sessionRange" : ""; };
  // The defaults (#1670: 48 h / 48 h, DEFAULT_SESSION_POLICY); an idle time left blank follows a shorter session, as
  // the store and the validator apply it — so only an idle time that is typed can exceed the session length.
  const abs = value(f.abs) ?? 48, idle = value(f.idle) ?? Math.min(48, abs);
  const errors = {
    hostname: f.hostname && !/^(?:https:\/\/)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\/?$/.test(f.hostname) ? "namedHostnameInvalid" : "",
    originPort: !Number.isInteger(Number(f.originPort)) || Number(f.originPort) < 1024 || Number(f.originPort) > 65535 ? "namedPortInvalid" : "",
    ttl: !Number.isInteger(Number(f.ttl)) || Number(f.ttl) < 1 || Number(f.ttl) > 480 ? "publicTtl" : "",
    abs: hours(f.abs),
    idle: hours(f.idle) || (!hours(f.abs) && idle > abs ? "sessionIdleOver" : ""),
    termTtl: value(f.termTtl) !== null && (!Number.isInteger(value(f.termTtl)) || value(f.termTtl) < 1 || value(f.termTtl) > 20) ? "webTerminalTtlRange" : "",
  };
  const ready = !overPublicLink && !Object.values(errors).some(Boolean);
  const review = (quiet = false) => {
    // #2347: invalid text keeps the draft unsaved and Save waiting ("Fix 1 field to save"); no older valid draft is sent.
    if (overPublicLink) return;
    if (!ready) {
      syncStage(ctx, "web", { label: tn("sec_web"), invalid: tn(Object.values(errors).find(Boolean)) });
      return;
    }
    // Keep an existing secret reference, including a custom one. Only a newly supplied hostname without any
    // reference adopts the standard env key; mounting or editing an unrelated field never rewrites credentials.
    const tokenEnv = f.hostname === original.pub.hostname ? original.pub.tunnel_token_env
      : f.hostname ? original.pub.tunnel_token_env || "AGEND_CLOUDFLARE_TUNNEL_TOKEN" : "";
    const publicPatch = changedFields({ allow_public: f.pub, ttl_minutes: Number(f.ttl), protocol: f.protocol, hostname: f.hostname, tunnel_token_env: tokenEnv, origin_port: Number(f.originPort) }, original.pub);
    const sessionPatch = changedFields({ absolute_hours: value(f.abs), idle_hours: value(f.idle) }, original.session);
    // The checkbox shows the default (on) for an unset key: only a real toggle is written; on again = back to the default.
    const terminalPatch = changedFields({ enabled: f.termOn === (original.terminal.enabled !== false) ? original.terminal.enabled : f.termOn ? null : false,
      ttl_minutes: value(f.termTtl) }, original.terminal);
    const body = {
      ...(f.echo !== original.echo ? { echo_to_channel: f.echo } : {}),
      ...(f.log !== original.log ? { log_tab: f.log } : {}),
      ...(f.usagePub !== original.usagePub ? { usage_report_on_public_link: f.usagePub } : {}),
      ...(Object.keys(publicPatch).length ? { public_link: publicPatch } : {}),
      ...(Object.keys(sessionPatch).length ? { session: { local: sessionPatch } } : {}),
      ...(Object.keys(terminalPatch).length ? { web_terminal: terminalPatch } : {}),
    };
    const fields = [
      ...(body.echo_to_channel !== undefined ? ["web.echo_to_channel"] : []),
      ...(body.log_tab !== undefined ? ["web.log_tab"] : []),
      ...(body.usage_report_on_public_link !== undefined ? ["web.usage_report_on_public_link"] : []),
      ...Object.keys(publicPatch).map((k) => `web.public_link.${k}`),
      ...Object.keys(sessionPatch).map((k) => `web.session.local.${k}`),
      ...Object.keys(terminalPatch).map((k) => `web_terminal.${k}`),
    ];
    if (fields.length) {
      ctx.stage("web", { label: tn("sec_web"), count: fields.length, impact: batchImpact(schema, fields, (k) => impactOf(schema, k)),
        request: { method: "PUT", url: "/api/settings/fleet/web", body } }, quiet);
    } else if (staged.has("web")) ctx.unstage("web");
  };
  // This form already has validation and a single shared Web draft. Valid edits join that draft immediately;
  // Apply, its confirmations and the leave guard still own all HTTP writes. Quiet staging avoids a toast per key.
  // Returning from another Settings section remounts this form: its unchanged initial fields must not erase the
  // parent's already-staged Web draft. Only an actual field edit replaces or removes that draft.
  const formMounted = useRef(false);
  useEffect(() => { if (!formMounted.current) { formMounted.current = true; return; } review(true); }, [f]);
  const shown = (path) => {
    const [top, key] = path.split(".");
    const v = (top === "web" ? web : term)[key];
    return v === undefined ? tn("notSet") : typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  return html`<div class="form s-web">
    <p class="sub">${tn("webLead")}</p>
    ${overPublicLink ? html`<p class="note" role="status" id="webPublicRefused">${tn("webPublicRefused")}</p>` : null}
    <fieldset class="s-web-fields" disabled=${overPublicLink}>
    <section class="card"><h3>${tn("webSessionTitle")}</h3>
      <p class="note">${tn("webSessionHint")}</p>
      <div class="grid2">
        <div class=${fc("field", "abs")}><label for="webSessionAbsolute">${tn("sessionAbsolute")}</label><input id="webSessionAbsolute" type="number" min="1" max="720" step="any" placeholder=${tn("defaultHours", 48)}
          class=${errors.abs ? "invalid" : ""} value=${f.abs} onInput=${(e) => set("abs")(e.target.value)} /><${Feedback} error=${errors.abs} /></div>
        <div class=${fc("field", "idle")}><label for="webSessionIdle">${tn("sessionIdle")}</label><input id="webSessionIdle" type="number" min="1" max="720" step="any" placeholder=${tn("defaultHours", 48)}
          class=${errors.idle ? "invalid" : ""} value=${f.idle} onInput=${(e) => set("idle")(e.target.value)} /><${Feedback} error=${errors.idle} /></div>
      </div>
    </section>
    <section class="card"><h3>${tn("webTerminalTitle")}</h3>
      <p class="note">${tn("webTerminalHint")}</p>
      <label class=${fc("check", "termOn")}><input id="webTerminalEnabled" type="checkbox" checked=${f.termOn} onChange=${(e) => set("termOn")(e.target.checked)} /><span>${tn("webTerminalEnabled")}</span><${Impact} schema=${schema} field="web_terminal.enabled" /></label>
      <div class="grid2">
        <div class=${fc("field", "termTtl")}><label for="webTerminalTtl">${tn("webTerminalTtl")}</label><input id="webTerminalTtl" type="number" min="1" max="20" step="1" placeholder=${tn("defaultHours", 10)}
          class=${errors.termTtl ? "invalid" : ""} value=${f.termTtl} onInput=${(e) => set("termTtl")(e.target.value)} /><${Feedback} error=${errors.termTtl} /></div>
      </div>
    </section>
    <section class="card"><h3>${tn("webChat")}</h3>
      <label class=${fc("check", "echo")}><input id="webEchoToChannel" type="checkbox" checked=${f.echo} onChange=${(e) => set("echo")(e.target.checked)} /><span>${tn("webEcho")}</span><${Impact} schema=${schema} field="web.echo_to_channel" /></label>
      <p class="note">${tn("webEchoHint")}</p>
      <label class=${fc("check", "log")}><input id="webLogTab" type="checkbox" checked=${f.log} onChange=${(e) => set("log")(e.target.checked)} /><span>${tn("webLogTab")}</span><${Impact} schema=${schema} field="web.log_tab" /></label>
      <p class="note">${tn("webLogTabHint")}</p>
      <label class=${fc("check", "usagePub")}><input id="webUsagePublic" type="checkbox" checked=${f.usagePub} onChange=${(e) => set("usagePub")(e.target.checked)} /><span>${tn("webUsagePublic")}</span><${Impact} schema=${schema} field="web.usage_report_on_public_link" /></label>
      <p class="note">${tn("webUsagePublicHint")}</p>
      <label class=${fc("check", "pub")}><input id="publicWebLink" type="checkbox" checked=${f.pub} onChange=${(e) => set("pub")(e.target.checked)} /><span>${tn("publicLink")}</span><${Impact} schema=${schema} field="web.public_link.allow_public" /></label>
      <p class="note">${tn("publicLinkHint")}</p>
      <div class="grid2">
        <div class=${fc("field", "hostname")}><label for="publicWebHostname">${tn("namedHostname")}</label><input id="publicWebHostname" type="text" value=${f.hostname} placeholder="agend.example.com" class=${errors.hostname ? "invalid" : ""} onInput=${(e) => set("hostname")(e.target.value)} /><${Feedback} error=${errors.hostname} /></div>
        <div class=${fc("field", "originPort")}><label for="publicWebOriginPort">${tn("namedOriginPort")}</label><input id="publicWebOriginPort" type="number" min="1024" max="65535" value=${f.originPort} class=${errors.originPort ? "invalid" : ""} onInput=${(e) => set("originPort")(e.target.value)} /><${Feedback} error=${errors.originPort} /></div>
      </div>
      <p class="note">${tn("namedTunnelHint")} <a href="https://github.com/songsid/AgEnD/blob/main/docs/named-tunnel.md" target="_blank" rel="noopener noreferrer">${tn("namedTunnelSetup")}</a></p>
      <div class="grid2">
        <div class=${fc("field", "ttl")}><label for="publicWebTtl">${tn("publicTtl")}</label><input id="publicWebTtl" type="number" min="1" max="480" class=${errors.ttl ? "invalid" : ""} value=${f.ttl} onInput=${(e) => set("ttl")(e.target.value)} /><${Feedback} error=${errors.ttl} /></div>
        <div class=${fc("field", "protocol")}><label for="publicWebProtocol">${tn("publicProtocol")}</label><${Select} id="publicWebProtocol" value=${f.protocol} onChange=${set("protocol")} options=${["http2", "quic", "auto"]} /></div>
      </div>
    </section>
    </fieldset>
    ${overPublicLink ? null : html`<${PublicTunnelToken} /><${GuestsCard} ctx=${ctx} staged=${staged} /><${WebAuthorityCard} ctx=${ctx} staged=${staged} />`}
    <section class="card s-web-readonly"><h3>${tn("webReadOnlyTitle")}</h3>
      <p class="note">${tn("webReadOnlyLead")}</p>
      <dl class="s-web-ro">${WEB_READ_ONLY.map((k) => html`<div key=${k}><dt><code>${k}</code></dt><dd>${shown(k)}</dd></div>`)}</dl>
    </section>
  </div>`;
}

/** Developer: the fleet model as YAML or JSON, to read, copy, download — or edit and apply as one operation. */
function Developer({ ctx }) {
  const [fmt, setFmt] = useState("yaml");
  const [editing, setEditing] = useState(false);
  const model = fleetModel(ctx.fleet);
  const text = fmt === "yaml" ? toYaml(model) : JSON.stringify(model, null, 2);
  const [draft, setDraft] = useState(text);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  const copy = () => { try { navigator.clipboard.writeText(text).then(() => setMsg({ text: tn("copied") }), () => setMsg({ error: tn("failed") })); } catch { setMsg({ error: tn("failed") }); } };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toYaml(fleetModel(ctx.fleet))], { type: "text/plain" }));
    a.download = "fleet.yaml"; a.click(); URL.revokeObjectURL(a.href);
  };
  const save = () => {
    let parsed;
    try { parsed = fmt === "yaml" ? fromYaml(draft) : JSON.parse(draft || "{}"); } catch (e) { setMsg({ error: e.message }); return; }
    if (!parsed || typeof parsed !== "object") { setMsg({ error: tn("expectedMapping") }); return; }
    const requests = fullModelRequests(parsed, ctx.fleet);
    if (!requests.length) { setMsg({ text: tn("noChanges") }); return; }
    if (operationActive()) { setMsg({ error: tn("applyBusyLocal") }); return; }
    // The whole edit is one operation: its writes in order, then the apply — the same runner as every Apply.
    if (startOperation(requests.map((r) => ({ label: `${r.method} ${decodeURIComponent(r.url.replace("/api/settings/", ""))}`, impact: requestImpact(ctx.schema, r), request: r })))) {
      setEditing(false); setMsg(null);
    }
  };
  return html`<section class="card s-dev">
    <div class="s-dev-bar">
      <div class="seg-inline" role="group" aria-label=${tn("format")}>
        ${["yaml", "json"].map((k) => html`<button key=${k} type="button" class=${`btn btn-sm${fmt === k ? " on" : ""}`} aria-pressed=${fmt === k ? "true" : "false"} onClick=${() => setFmt(k)}>${k.toUpperCase()}</button>`)}</div>
      ${ctx.readOnly ? null : html`<button type="button" class="btn btn-sm" onClick=${() => setEditing(!editing)}>${editing ? tn("viewMode") : tn("editMode")}</button>`}
      <button type="button" class="btn btn-sm" title=${tn("copy")} onClick=${copy}><${Icon} name="copy" size=${14} /><span class="lbl">${tn("copy")}</span></button>
      <button type="button" class="btn btn-sm" title=${tn("devDownload")} onClick=${download}><${Icon} name="download" size=${14} /><span class="lbl">${tn("devDownload")}</span></button>
    </div>
    ${editing && !ctx.readOnly ? html`<textarea class="s-yaml" aria-label=${tn("devEditor")} spellcheck=${false} wrap="off" value=${draft} onInput=${(e) => setDraft(e.target.value)}></textarea>
        <div class="save-row"><button type="button" class="btn btn-primary" onClick=${save}>${tn("devApply")}</button><span class="note">${tn("devApplyHint")}</span></div>`
      : html`<pre class="s-yaml">${text}</pre>`}
    ${msg ? html`<p class=${`feedback${msg.error ? " error" : ""}`} role="status">${msg.error || msg.text}</p>` : null}
  </section>`;
}

/**
 * #2347: the section's Save. Shown while anything is unsaved: how many changes, what they will cost, Discard and Save —
 * Save waits while a field is invalid ("Fix 1 field to save").
 */
function PendingBar({ staged, busy, onApply, onDiscard }) {
  const changes = [...staged.values()];
  const kinds = [...new Set(changes.filter((c) => !c.invalid).map((c) => c.impact))];
  const invalid = changes.filter((c) => c.invalid).length;
  const count = changes.reduce((n, c) => n + (Number.isInteger(c.count) && c.count > 0 ? c.count : 1), 0);
  return html`<div data-trust="panel-controls" class="s-pending" role="region" aria-label=${tn("pendingRegion")}>
    <strong>${tn("changesPending", count)}</strong>
    <span class="note">${kinds.map(impactText).join(" · ")}</span>
    <span class="s-pending-actions">
      ${invalid ? html`<span class="feedback error s-fix" role="status">${tn("fixToSave", invalid)}</span>` : null}
      <button type="button" class="btn" onClick=${onDiscard} disabled=${busy}>${tn("discard")}</button>
      <button type="button" class="btn btn-primary" onClick=${onApply} disabled=${busy || invalid > 0} title=${busy ? tn("applyBusyLocal") : undefined}>${tn("applyChanges")}</button>
    </span>
  </div>`;
}

/** The Apply in hand (the app's, settings-apply.js): its writes, its job, and a restart when one is needed. */
function OperationCard({ op, schema }) {
  const [restarting, setRestarting] = useState(false);
  const busy = opBusy(op);                                 // nothing to dismiss while it, or its restart, runs
  const phaseBusy = ["writing", "posting", "watching"].includes(op.phase);
  const job = op.job;
  const rows = (job && job.targets) || [];
  // A fleet row of kind "hot" is connections starting without a restart (#1519 P6), not AgEnD restarting.
  const fleetRestarting = job && job.status === "running" && rows.some((r) => r.target === "fleet" && r.status === "running" && r.kind !== "hot");
  const needsRestart = rows.some((r) => r.status === "restart-required");
  const failedRows = rows.some((r) => r.status === "failed");
  const mismatch = schema && schema.fleet_signature_mismatch;
  const title = op.phase === "failed" ? tn("applyPartial") : fleetRestarting ? tn("restartFleetTitle") : busy ? tn("applying")
    : failedRows ? tn("applyPartial") : needsRestart ? tn("applyRestartNeeded") : tn("applyDone");
  const note = op.phase === "failed" ? (op.error === "busy" ? tn("applyBusy") : op.error ? tn("applyStepFailed", applyErrorText(op.error)) : "")
    : fleetRestarting ? tn("restartFleetWaiting") : op.lostJob ? tn("applyLostJob")
    : job && job.overdue ? tn("applyStillWorking", Math.round((job.elapsed_ms || 0) / 1000))
    : mismatch && needsRestart ? tn("signatureMismatch", mismatch.join(", ")) : needsRestart ? tn("applyRestartHint") : "";
  const lease = useLease("operation-card");
  const restart = async () => {
    // The yes is for the job this card shows: it restarts AgEnD for that job only, and only while the card stands.
    const forJob = { opId: op.id, jobId: op.job && op.job.id };
    if (!(await ask(tn("restartFleetConfirm"), { title: tn("restartFleetButton"), confirmLabel: tn("restartFleetButton"), danger: true }))) return;
    if (!lease.current()) return;
    setRestarting(true);
    const res = await restartFleet(forJob);
    if (!lease.current()) return;
    setRestarting(false);
    if (!res.ok) {
      const secs = res.body && res.body.retry_after_seconds;
      toast(secs ? tn("restartFleetRateLimited", (res.body && res.body.error) || "", Math.ceil(secs / 60)) : tn("restartFleetRefused", (res.body && res.body.error) || tn("applyFailed")), false);
    }
  };
  const icon = (s) => (s === "done" ? "check" : s === "failed" ? "alert" : s === "waiting" ? "clock" : s === "running" ? "restart" : null);
  return html`<section class=${`card s-op ${op.phase}`} role="status" aria-live="polite">
    <div class="s-op-head"><strong>${title}</strong><span class="grow"></span>
      ${busy ? null : html`<button type="button" class="icon-btn" aria-label=${t("app.close")} title=${t("app.close")} onClick=${dismissOperation}><${Icon} name="close" size=${16} /></button>`}</div>
    ${note ? html`<p class="note">${note}</p>` : null}
    ${op.steps.length ? html`<ul class="s-op-steps">${op.steps.map((s, i) => html`<li key=${i} class=${`s-step ${s.status}`}>
      <span class="s-step-icon" aria-hidden="true">${icon(s.status) ? html`<${Icon} name=${icon(s.status)} size=${14} />` : "·"}</span>
      <span class="grow">${s.label}</span>
      <span class="note">${s.status === "waiting" ? tn("stepWaiting") : s.status === "skipped" ? tn("stepSkipped") : s.status === "failed" ? (s.error ? applyErrorText(s.error) : tn("applyFailed")) : s.note || impactText(s.impact)}</span></li>`)}</ul>` : null}
    ${rows.length ? html`<ul class="s-op-steps">${rows.map((r) => html`<li key=${r.target} class=${`s-step ${r.status}`}>
      <span class="s-step-icon" aria-hidden="true">${r.status === "done" ? html`<${Icon} name="check" size=${14} />` : r.status === "failed" ? html`<${Icon} name="alert" size=${14} />` : r.status === "restart-required" ? html`<${Icon} name="restart" size=${14} />` : "·"}</span>
      <span class="grow">${r.target === "fleet" ? "AgEnD" : shortName(r.target, {})}</span>
      <span class="note">${r.target === "fleet" && r.status === "running" ? tn(r.kind === "hot" ? "connStartingNow" : "restartFleetTitle") : r.status === "restart-required" ? tn("applyRestartNeeded")
        : r.settled_by === "no-change" ? tn("applyNoChange") : r.settled_by === "fleet-restart" ? tn("viaRestart") : r.kind === "hot" ? tn("impactNow") : tn("impactAgent")}</span>
      ${r.error ? html`<span class="feedback error">${r.error}</span>` : null}</li>`)}</ul>` : null}
    ${job && job.error ? html`<p class="feedback error">${job.error}</p>` : null}
    ${needsRestart && !mismatch && !phaseBusy ? html`<div class="save-row"><button type="button" class="btn btn-primary" disabled=${restarting || op.restart === "busy"} onClick=${restart}>
      ${restarting || op.restart === "busy" ? tn("restartFleetBusy") : tn("restartFleetButton")}</button></div>` : null}
  </section>`;
}

function HelpDialog({ onClose }) {
  return html`<${Dialog} title=${tn("helpTitle")} onClose=${onClose} actions=${html`<button type="button" class="btn btn-primary" onClick=${onClose}>${tn("close")}</button>`}>
    <ul class="help-list">${["help1", "help2", "help3", "help4", "help5", "help6"].map((k) => html`<li key=${k}>${tn(k)}</li>`)}</ul>
  </${Dialog}>`;
}

export { worstImpact, ACCESS_MODES };

function PublicTunnelToken() {
  const lease = useLease("public-tunnel-token");
  const [secret, setSecret] = useState("");
  const [present, setPresent] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState("");
  const base = "/api/settings/public-tunnel-token";
  const refresh = async () => {
    const result = await api(base);
    if (lease.current() && result.ok) setPresent(result.body?.[0]?.token_present === true);
  };
  useEffect(() => { refresh().catch(() => {}); }, []);
  const go = async (clear) => {
    if (inFlight.current || !clear && !secret) return;
    const value = secret;
    setSecret(""); inFlight.current = true; setBusy(true); setMessage("");
    const key = newKey("tunnel-token");
    try {
      const prepared = await api(`${base}/verify`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(clear ? { clear: true } : { secret: value }) });
      if (!lease.current()) return;
      if (!prepared.ok) throw Error("refused");
      const applied = await confirmedWrite(`${base}/apply`, { method: "POST", key, label: tn(clear ? "namedTokenClear" : "namedTokenSet"), body: { verification_id: prepared.body?.verification_id, idempotency_key: key } });
      let body = applied.body || {};
      for (let n = 0; applied.ok && body.job_id && body.result === "applying" && n < 60; n++) {
        await new Promise(r => setTimeout(r, 250));
        const status = await api(`${base}/apply/${encodeURIComponent(body.job_id)}`);
        if (status.ok) body = status.body || body;
      }
      if (lease.current()) {
        setMessage(tn(applied.ok && body.result === "reloaded" ? "namedTokenSaved" : body.result === "pending_confirmation" ? "awaitingConfirmation" : "applyFailed"));
        await refresh();
      }
    } catch { if (lease.current()) setMessage(tn("applyFailed")); }
    finally { inFlight.current = false; if (lease.current()) setBusy(false); }
  };
  return html`<section class="card"><h3>${tn("namedToken")}</h3>
    <p class="note">${tn("namedTokenHint")}</p>
    <span class="tag">${present ? tn("keyConfigured") : tn("keyNotConfigured")}</span>
    <input id="publicTunnelToken" type="password" autocomplete="new-password" aria-label=${tn("namedToken")} value=${secret} onInput=${e => setSecret(e.target.value)} />
    <button type="button" class="btn btn-sm" disabled=${busy || !secret} onClick=${() => go(false)}>${tn("namedTokenSet")}</button>
    <button type="button" class="btn btn-sm" disabled=${busy || !present} onClick=${() => go(true)}>${tn("namedTokenClear")}</button>
    ${message ? html`<p class="note" role="status">${message}</p>` : null}
  </section>`;
}

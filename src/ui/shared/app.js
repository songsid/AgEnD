// #1408: the web app's entry. One page for every route of the app (/ui, /ui/chat/<name>, /ui/fleet[/<tab>], /view,
// /view/<name>, /settings[/<section>], /ui/needs); the server says on <body> which mode this load is in and how live updates travel (app-stream.js).
//
// Public closure (#1408 §4): this file and everything it imports statically are served from /assets/ without a
// session, and so is View (panel-view.js, loaded on demand). The panels that need a session live under /ui/js/ and are
// reached only by the dynamic imports below, in "full" mode. A test walks the static imports over real HTTP and asserts
// none of them names /ui/.
import { html, render } from "./app-html.js";
import { Shell, handleKey, showDialog, closeDrawer, retryable, setNewInstanceOpener } from "./app-shell.js";
import { startRouter, navStore, navigate } from "./app-nav.js";
import { createStream } from "./app-stream.js";
import { appStore, applyStatus, applyActivity } from "./app-store.js";
import { chatPath } from "./app-route.js";
import { startNeedsNotifier } from "./app-needs.js";
import { toast } from "./ui-toast.js";
import { t } from "./app-i18n.js";
import { initTextSize } from "./header-tools.js";

const boot = document.body.dataset;
// #1523 N3: this device's text size, on the root before the first paint of any panel.
initTextSize();
// "full": a signed-in page. "view-only": an anonymous reader of /view under web.view_access: open — no stream, no
// session-only panel, nothing under /ui/ is ever imported or read (#1408 §3).
const mode = boot.mode === "view-only" ? "view-only" : "full";
appStore.set({ viewOnly: mode === "view-only" });

// A failed load can be retried (the panel's Retry): each retry asks for a fresh URL, since a browser may keep a failed
// module import cached under the first one. boot() runs once, whichever attempt succeeds.
const retryUrl = (path, attempt) => (attempt ? `${path}?retry=${attempt}` : path);
// View is public (it is what an anonymous reader may open), so it lives under /assets/ beside this file.
const loadView = retryable((a) => import(retryUrl("/assets/panel-view.js", a)));
const panels = new Map([["view", { load: () => loadView().then((m) => m.ViewPanel) }]]);
let onNewInstance = null;

if (mode === "full") {
  const stream = createStream({ mode, transport: boot.webTransport });
  stream.on("status", applyStatus);
  stream.on("activity", applyActivity);
  stream.on("connection", (connection) => appStore.set({ connection }));
  // #1580: when the next reconnect try is (the connection line counts down to it; monotonic, like the stream's clock).
  stream.on("retry", (r) => appStore.set({ retryAt: (typeof performance !== "undefined" ? performance.now() : Date.now()) + r.inMs }));
  // #1580: a page that leaves closes its stream and every timer (nothing half-open behind it); one restored from the
  // back-forward cache reconnects and catches up.
  window.addEventListener("pagehide", () => stream.suspend());
  window.addEventListener("pageshow", (e) => { if (e.persisted) stream.resume(); });
  // A chat that loaded late catches up on what is open now; the shell shows that while it is not done, with Retry.
  stream.on("hydration", (hydration) => appStore.set({ hydration }));
  appStore.set({ retryHydration: () => stream.catchUp() });
  stream.on("needs", (d) => appStore.set({ needs: Array.isArray(d && d.items) ? d.items : [] }));
  appStore.set({ connection: stream.connection() });

  // The chat's store must hear every message from the first frame, whatever panel is open: its module boots once,
  // now, for the life of the page. Fleet loads the first time it is opened.
  const loadChat = retryable((a) => import(retryUrl("/ui/js/panel-chat.js", a)).then((m) => {
    // The chat store this page booted — whichever import succeeded (a Retry loads ?retry=<n>) — is the page's one owner
    // of its prompts; Needs you finds it here and never imports the chat itself (#1463 review).
    appStore.set({ chatOwner: m.boot({ stream, boot }) });
    // Loaded only after the stream opened (a Retry): the frames sent on connect never reached it — catch up once.
    if (stream.started()) stream.catchUp();
    return m;
  }));
  const loadFleet = retryable((a) => import(retryUrl("/ui/js/panel-fleet.js", a)));
  const loadSettings = retryable((a) => import(retryUrl("/ui/js/panel-settings.js", a)));
  const loadNeeds = retryable((a) => import(retryUrl("/ui/js/panel-needs.js", a)));
  const loadDetails = retryable((a) => import(retryUrl("/ui/js/panel-details.js", a)));
  // The stream opens once the chat listens, so the frames sent on connect (status, open prompts, ticks) reach it too.
  // If the chat cannot load (a session that just ended), the stream still opens for the sidebar.
  const chatBoot = loadChat();
  chatBoot.catch(() => {}).finally(() => stream.start());
  // The Outlet's first load of the chat is that same boot attempt, failed or not; only Retry starts another. (Otherwise
  // a boot import that failed before the Outlet first asked would be retried at once, depending on timing.)
  let chatLoads = 0;
  panels.set("chat", { load: () => (chatLoads++ === 0 ? chatBoot : loadChat()).then((m) => m.ChatPanel) });
  panels.set("fleet", { load: () => loadFleet().then((m) => m.FleetPanel) });
  panels.set("settings", { load: () => loadSettings().then((m) => m.SettingsPanel) });
  panels.set("needs", { load: () => loadNeeds().then((m) => m.NeedsPanel) });
  // #1523 N2: one instance's Details (/ui/fleet/agent/<name>).
  panels.set("details", { load: () => loadDetails().then((m) => m.DetailsPanel) });
  // #1386 §6.3: desktop notifications for new "Needs you" items, in any panel, while this signed-in page is open.
  startNeedsNotifier({ open: (instance) => navigate(chatPath(instance)) });
  onNewInstance = async () => {
    closeDrawer();                                 // on a phone the dialog opens from the drawer: the drawer goes first
    let m;
    try { m = await loadFleet(); } catch { toast(t("app.loadFailed"), false); return; }
    showDialog(m.CreateInstanceDialog);
  };
  setNewInstanceOpener(onNewInstance);
} else appStore.set({ connection: "none" });

startRouter(window);
// /ui on its own opens the chat this browser had open last (an unknown name shows the panel's "not found").
{
  const r = navStore.get().route;
  let last = null;
  try { last = localStorage.getItem("agend_last_instance"); } catch { /* none */ }
  if (mode === "full" && r && r.panel === "chat" && !r.instance && last) navigate(chatPath(last), { replace: true });
}

document.addEventListener("keydown", handleKey);

render(html`<${Shell} panels=${panels} onNewInstance=${onNewInstance} viewOnly=${mode === "view-only"} />`, document.getElementById("app"));

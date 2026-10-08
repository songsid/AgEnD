// #1408: the web app's entry. One page for every route of the app (/ui, /ui/chat/<name>, /ui/fleet[/<tab>]); the
// server says on <body> which mode this load is in and how live updates travel (app-stream.js).
//
// Public closure (#1408 §4): this file and everything it imports statically are served from /assets/ without a
// session. The panels that need one live under /ui/js/ and are reached only by the dynamic imports below, in "full"
// mode. A test walks the static imports over real HTTP and asserts none of them names /ui/.
import { html, render } from "./app-html.js";
import { Shell, handleKey, showDialog, closeDrawer, retryable } from "./app-shell.js";
import { startRouter, navStore, navigate } from "./app-nav.js";
import { createStream } from "./app-stream.js";
import { appStore, applyStatus, applyActivity } from "./app-store.js";
import { chatPath } from "./app-route.js";
import { toast } from "./ui-toast.js";
import { t } from "./app-i18n.js";

const boot = document.body.dataset;
const mode = boot.mode || "full";

const stream = createStream({ mode, transport: boot.webTransport });
stream.on("status", applyStatus);
stream.on("activity", applyActivity);
stream.on("connection", (connection) => appStore.set({ connection }));
stream.on("needs", (d) => appStore.set({ needs: Array.isArray(d && d.items) ? d.items : [] }));
appStore.set({ connection: stream.connection() });

// The chat's store must hear every message from the first frame, whatever panel is open: its module boots once,
// now, for the life of the page. Fleet loads the first time it is opened.
// A failed load can be retried (the panel's Retry): each retry asks for a fresh URL, since a browser may keep a failed
// module import cached under the first one. boot() runs once, whichever attempt succeeds.
const retryUrl = (path, attempt) => (attempt ? `${path}?retry=${attempt}` : path);
const loadChat = retryable((a) => import(retryUrl("/ui/js/panel-chat.js", a)).then((m) => {
  m.boot({ stream, boot });
  // Loaded only after the stream opened (a Retry): the frames sent on connect never reached it — catch up once.
  if (stream.started()) stream.catchUp();
  return m;
}));
const loadFleet = retryable((a) => import(retryUrl("/ui/js/panel-fleet.js", a)));
// The stream opens once the chat listens, so the frames sent on connect (status, open prompts, ticks) reach it too.
// If the chat cannot load (a session that just ended), the stream still opens for the sidebar.
loadChat().catch(() => {}).finally(() => stream.start());
const panels = new Map([
  ["chat", { load: () => loadChat().then((m) => m.ChatPanel) }],
  ["fleet", { load: () => loadFleet().then((m) => m.FleetPanel) }],
]);

startRouter(window);
// /ui on its own opens the chat this browser had open last (an unknown name shows the panel's "not found").
{
  const r = navStore.get().route;
  let last = null;
  try { last = localStorage.getItem("agend_last_instance"); } catch { /* none */ }
  if (r && r.panel === "chat" && !r.instance && last) navigate(chatPath(last), { replace: true });
}

document.addEventListener("keydown", handleKey);

async function onNewInstance() {
  closeDrawer();                                   // on a phone the dialog opens from the drawer: the drawer goes first
  let m;
  try { m = await loadFleet(); } catch { toast(t("app.loadFailed"), false); return; }
  showDialog(m.CreateInstanceDialog);
}

render(html`<${Shell} panels=${panels} onNewInstance=${onNewInstance} />`, document.getElementById("app"));

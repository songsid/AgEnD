// #2182: the worker that routes the org canvas's traffic lines (fleet-route-scene.js says what to route). It is served
// with a policy of its own (web-host-guard.ts ROUTE_WORKER_CSP): WebAssembly may run here, as it may not on the page,
// and it may reach nothing — the page fetches libavoid.wasm and hands the bytes over; they are instantiated from a
// blob: URL. It receives numbers and answers numbers; the page checks both.
import { AvoidLib } from "/ui/vendor/libavoid-0.4.5/libavoid.js";
import { answerRoute } from "./fleet-route-scene.js";

let ready = null;
self.onmessage = (ev) => {
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "init" && !ready && m.wasm instanceof ArrayBuffer) {
    const url = URL.createObjectURL(new Blob([m.wasm], { type: "application/wasm" }));
    ready = AvoidLib.load(url).then(() => AvoidLib.getInstance()).finally(() => URL.revokeObjectURL(url));
    ready.then(() => self.postMessage({ type: "ready" }), () => self.postMessage({ type: "failed" }));
    return;
  }
  if (m.type === "route" && ready && Number.isInteger(m.id)) {
    ready.then((A) => self.postMessage(answerRoute(A, m))).catch(() => self.postMessage({ type: "routes", id: m.id, routes: null }));
  }
};

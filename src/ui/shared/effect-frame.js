/** #1629: parent-owned Canvas Worker transport; the Chat adapter owns product admission. */
import { maySendEffectEvent } from "./effect-policy.js";
const plain = v => !!v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
const finite = v => typeof v === "number" && Number.isFinite(v);
const bytes = v => new TextEncoder().encode(v).byteLength;

/** Snapshot only host-validated code, primitives and raster bytes; no HTML or DOM interface exists. */
function snapshotRender(raw) {
  if (!exact(raw, ["code", "params", "instance", "width", "height", "dpr", "assets", "wants"]) || typeof raw.code !== "string" || !plain(raw.params) || !Array.isArray(raw.assets) || raw.assets.length > 16 || !Array.isArray(raw.wants) || Array.from(raw.wants).some(v => !["pointer", "state", "reply", "mention", "theme"].includes(v)) || new Set(raw.wants).size !== raw.wants.length) return null;
  if (raw.instance !== null && (typeof raw.instance !== "string" || raw.instance.length < 1 || raw.instance.length > 128)) return null;
  if (!Number.isInteger(raw.width) || raw.width < 1 || raw.width > 4096 || !Number.isInteger(raw.height) || raw.height < 1 || raw.height > 4096 || raw.width * raw.height > 8388608 || !finite(raw.dpr) || raw.dpr < 0.5 || raw.dpr > 3) return null;
  const params = Object.create(null), keys = Object.keys(raw.params);
  if (keys.length > 16) return null;
  for (const key of keys) {
    const value = raw.params[key];
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || !(typeof value === "boolean" || finite(value) || typeof value === "string" && value.length <= 128)) return null;
    params[key] = value;
  }
  let total = bytes(raw.code) + bytes(JSON.stringify(params));
  if (total > 1048576) return null;
  const assets = [], names = new Set();
  for (const a of raw.assets) {
    if (!exact(a, ["name", "mime", "bytes"]) || typeof a.name !== "string" || !/^assets\/[a-z0-9][a-z0-9_-]{0,63}\.(?:png|jpe?g|webp|gif)$/.test(a.name) || names.has(a.name) || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(a.mime) || !(a.bytes instanceof Uint8Array)) return null;
    total += a.bytes.byteLength;
    if (total > 1048576) return null;
    names.add(a.name);
    assets.push({ name: a.name, mime: a.mime, bytes: new Uint8Array(a.bytes) });
  }
  return { code: raw.code, params: { ...params }, instance: raw.instance, width: raw.width, height: raw.height, dpr: raw.dpr, assets, wants: [...raw.wants] };
}

/** Listener transport only; this does not grant HTML-preview or ordinary-effect consent. */
export function effectTransportReady(host, origin, boot) {
  try {
    const target = new URL(origin), page = new URL(host.location.origin);
    return origin === target.origin && ["http:", "https:"].includes(target.protocol) && ["http:", "https:"].includes(page.protocol)
      && target.origin !== page.origin && !(page.protocol === "https:" && target.protocol !== "https:") && typeof boot === "string" && /^[0-9a-f]{32}$/.test(boot);
  } catch { return false; }
}

/** #2118: same URL origin, opaque realm. This helper does not alter product admission or HTML preview consent. */
export function effectBootstrapReady(host, origin, boot) {
  try {
    const target = new URL(origin), page = new URL(host.location.origin);
    return origin === target.origin && target.origin === page.origin && ["http:", "https:"].includes(target.protocol)
      && typeof boot === "string" && /^[0-9a-f]{32}$/.test(boot);
  } catch { return false; }
}

/**
 * All options come from the host, never from an agent event or manifest origin. The registry supplies an admitted
 * root and geometry in a later integration. This primitive alone does not implement caps, clipping or profiling.
 */
export function createEffectFrame(options = {}) { return ownedEffectFrame(options, false); }

/** Unmounted foundation: the app continues using createEffectFrame until the separately reviewed cutover. */
export function createOpaqueEffectFrame(options = {}) { return ownedEffectFrame(options, true); }

function ownedEffectFrame({ window: host, root, origin, boot, render, clock = () => performance.now(), onReady = () => {}, onRemove = () => {} } = {}, sameListener) {
  if (!(sameListener ? effectBootstrapReady : effectTransportReady)(host, origin, boot)) return { ok: false, reason: sameListener ? "bootstrap_unknown" : "preview_unknown" };
  const payload = snapshotRender(render);
  if (!payload || !host || !root || root.ownerDocument !== host.document || typeof root.append !== "function" || typeof host.MessageChannel !== "function" || typeof clock !== "function" || typeof onReady !== "function" || typeof onRemove !== "function") return { ok: false, reason: "unsupported" };
  let mounted;
  try { mounted = clock(); } catch { return { ok: false, reason: "clock_unavailable" }; }
  if (!finite(mounted) || mounted < 0) return { ok: false, reason: "clock_unavailable" };
  const frame = host.document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.className = "agend-effect-frame";
  let removed = false, ready = false, transferred = false, loads = 0, channel = null, timer = null, last = mounted;
  const time = () => {
    let now; try { now = clock(); } catch { return null; }
    if (!finite(now) || now < last) return null;
    last = now; return now;
  };
  const state = () => ({ ready, removed, loads });
  const remove = reason => {
    if (removed) return;
    removed = true;
    host.removeEventListener("message", hello);
    frame.removeEventListener("load", load);
    if (timer !== null) host.clearTimeout(timer);
    if (channel) {
      channel.port1.removeEventListener("message", portReady);
      try { channel.port1.close(); } catch { /* already detached */ }
      try { channel.port2.close(); } catch { /* already transferred */ }
    }
    frame.remove();
    try { onRemove(reason); } catch { /* host callback cannot revive a removed frame */ }
  };
  const load = () => { loads++; if (loads > 1) remove("navigation"); };
  const current = () => {
    if (removed) return false;
    if (frame.parentNode !== root || frame.isConnected !== true) { remove("detached"); return false; }
    const now = time();
    if (now === null) { remove("clock_unavailable"); return false; }
    if (!ready && now - mounted >= 10000) { remove("startup_timeout"); return false; }
    return true;
  };
  const portReady = event => {
    if (removed || ready) return;
    let data; try { data = event.data; } catch { return; }
    if (!exact(data, ["type"]) || data.type !== "ready") return;
    if (!current()) return;
    ready = true;
    host.clearTimeout(timer); timer = null;
    channel.port1.removeEventListener("message", portReady);
    try { onReady(); } catch { remove("host_callback"); }
  };
  const hello = event => {
    if (removed || transferred) return;
    let data; try { data = event.data; } catch { return; }
    // Opaque sandbox messages have origin null. Only this exact WindowProxy and boot may receive the private port.
    if (event.source !== frame.contentWindow || event.origin !== "null" || event.ports?.length || !exact(data, ["v", "type", "ch", "boot"]) || data.v !== 1 || data.type !== "ready" || data.ch !== null || data.boot !== boot) return;
    if (!current()) return;
    transferred = true;
    host.removeEventListener("message", hello);
    try {
      channel = new host.MessageChannel();
      channel.port1.addEventListener("message", portReady);
      channel.port1.start();
      const nonce = new Uint8Array(16); host.crypto.getRandomValues(nonce);
      const ch = Array.from(nonce, b => b.toString(16).padStart(2, "0")).join("");
      const { wants, ...message } = payload;
      // '*' is required for the opaque destination; the source WindowProxy was checked immediately above.
      frame.contentWindow.postMessage({ v: 1, type: "render", ch, ...message }, "*", [channel.port2]);
    } catch { remove("transport"); }
  };
  const deadline = () => {
    if (!current() || ready) return;
    timer = host.setTimeout(deadline, Math.max(1, 10000 - (last - mounted)));
  };
  host.addEventListener("message", hello);
  frame.addEventListener("load", load);
  timer = host.setTimeout(deadline, 10000);
  try { frame.src = origin + (sameListener ? "/effect-bootstrap" : "/effect"); root.append(frame); } catch { remove("mount_failed"); }
  return { ok: true, element: frame, state, remove,
    send(event) {
      if (!ready || !current() || !maySendEffectEvent(event, { instance: payload.instance, wants: payload.wants })) return false;
      try { channel.port1.postMessage(event); return true; } catch { remove("transport"); return false; }
    },
  };
}

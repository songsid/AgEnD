import { createStore } from "/assets/app-store.js";
import { register, t } from "/assets/app-i18n.js";
import { isSafeInstanceName } from "/assets/app-route.js";
import { dropBox, dropZone, floatBox, splitSize } from "/assets/pane-geometry.js";

register("paneGeometry", {
  en: { float: "Free floating pane", move: "Move floating pane", resize: "Resize floating pane", sash: "Resize chat panes", reset: "Reset to equal halves",
    left: "Dock left", right: "Dock right", top: "Dock above", bottom: "Dock below", center: "Replace this pane", help: "Arrow keys move or resize; Shift makes larger steps. Enter applies, Esc cancels.", changed: "Pane arrangement updated.", resized: "Pane size updated." },
  "zh-TW": { float: "自訂移動", move: "移動浮窗", resize: "調整浮窗大小", sash: "調整對話窗格大小", reset: "重設為各半",
    left: "停靠左側", right: "停靠右側", top: "停靠上方", bottom: "停靠下方", center: "取代此格", help: "用方向鍵移動或調整大小，Shift 加大幅度；Enter 套用，Esc 取消。", changed: "已更新窗格排列。", resized: "已更新窗格大小。" },
});
export const geometryText = key => t(`paneGeometry.${key}`);
const modified = e => e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.getModifierState?.("AltGraph");
const sameBounds = (a, b) => ["left", "top", "width", "height"].every(key => a[key] === b[key]);

/** Page-local gestures only. One owned native drag or pointer/keyboard operation; never a transport or write runner. */
export function createWorkspaceGestures({ controller, getRoot, onDrop = (name, target, zone) => controller.dock(name, target, zone) }) {
  const doc = document, win = window;
  const store = createStore({ transient: null, keyboard: null, announcement: "" });
  let alive = true, active = null, overlay = null;
  const usable = () => {
    const root = getRoot(), rect = root?.getBoundingClientRect();
    return alive && root?.isConnected && rect?.width >= 760 && win.innerWidth >= 1200 && !root.classList.contains("ws-compact")
      && !doc.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');
  };
  const valid = a => alive && active === a && controller.stamp() === a.stamp && getRoot() === a.root && usable() && sameBounds(a.bounds, a.root.getBoundingClientRect());
  const hideOverlay = () => { overlay?.remove(); overlay = null; };
  const locate = (x, y) => {
    const w = controller.current(), root = getRoot();
    const ids = w?.layout === "float" ? [w.floating, w.floating === "a" ? "b" : "a"] : ["a", "b"];
    if (!w) return { id: "a", rect: root.getBoundingClientRect() };
    for (const id of ids) {
      const rect = root.querySelector(`[data-pane="${id}"]`)?.getBoundingClientRect();
      if (rect && dropZone(rect, x, y)) return { id, rect };
    }
    return null;
  };
  const preview = (a, x, y, floating = false) => {
    a.target = null;
    const hit = floating ? { id: a.id === "a" ? "b" : "a", rect: a.bounds } : locate(x, y);
    if (!hit) { hideOverlay(); return; }
    const zone = dropZone(hit.rect, x, y);
    if (!zone || (floating && zone === "center")) { hideOverlay(); return; }
    a.target = { id: hit.id, zone };
    // Keep the browser's native drop target alive between dragover and drop.
    if (!overlay) {
      overlay = doc.createElement("div"); overlay.className = "ws-drop-overlay"; overlay.setAttribute("aria-hidden", "true");
      const box = doc.createElement("div"); box.className = "ws-drop-target"; box.appendChild(doc.createElement("span")); overlay.appendChild(box); doc.body.appendChild(overlay);
    }
    const box = overlay.firstElementChild, label = box.firstElementChild, rect = dropBox(hit.rect, zone);
    box.setAttribute("data-zone", zone); box.setAttribute("data-target", hit.id); label.textContent = geometryText(zone);
    // CSSOM follows the preview/sidebar resizers; no CSP-blocked style attribute or user-controlled CSS text.
    for (const [key, value] of Object.entries(a.bounds)) if (["left", "top", "width", "height"].includes(key)) overlay.style.setProperty(key, `${value}px`);
    for (const [key, value] of Object.entries(rect)) box.style.setProperty(key, `${value - (key === "left" ? a.bounds.left : key === "top" ? a.bounds.top : 0)}px`);
  };
  const finish = (commit = false) => {
    const a = active; if (!a) return;
    const accepted = commit && valid(a);
    active = null; a.off?.(); hideOverlay(); a.root.classList.remove("ws-resizing");
    store.set({ transient: null, keyboard: null });
    if (!accepted) return;
    if (a.target) { onDrop(a.name, a.target.id, a.target.zone); store.set({ announcement: geometryText("changed") }); }
    else if (a.change) { controller.geometry(a.change); store.set({ announcement: geometryText("resized") }); }
  };
  const cancel = () => finish(false);
  const make = (kind, id) => {
    if (!usable() || active) return null;
    const root = getRoot(), w = controller.current(), { left, top, width, height } = root.getBoundingClientRect();
    return active = { kind, id, name: w?.[id]?.route.instance, root, bounds: { left, top, width, height }, stamp: controller.stamp(), target: null, change: null };
  };
  const resizeFloat = (bounds, box, dx, dy) => {
    const fit = floatBox(bounds.width - box.x, bounds.height - box.y, { x: 0, y: 0, width: box.width + dx, height: box.height + dy });
    return { ...fit, x: box.x, y: box.y };
  };
  const down = (kind, id, e) => {
    if (e.button !== 0 || modified(e)) return;
    const w = controller.current();
    if (!w || (kind !== "sash" && (w.layout !== "float" || w.floating !== id))) return;
    controller.focus(id || w.focus);
    const a = make(kind, id); if (!a) return;
    e.preventDefault();
    if (kind !== "move") a.root.classList.add("ws-resizing");
    const el = e.currentTarget, pointerId = e.pointerId, x = e.clientX, y = e.clientY;
    const split = splitSize(a.bounds.width, a.bounds.height, w.layout, w.ratio), box = floatBox(a.bounds.width, a.bounds.height, w.rect);
    const owns = ev => ev.pointerId === undefined || ev.pointerId === pointerId;
    const move = ev => {
      if (!owns(ev) || active !== a) return;
      if (!valid(a)) { cancel(); return; }
      const dx = ev.clientX - x, dy = ev.clientY - y;
      if (kind === "move" && !a.change && Math.hypot(dx, dy) < 6) return;
      a.root.classList.add("ws-resizing");
      if (kind === "sash") {
        const total = (w.layout === "stack" ? a.bounds.height : a.bounds.width) - 8;
        a.change = { ratio: splitSize(a.bounds.width, a.bounds.height, w.layout, (split.first + (w.layout === "stack" ? dy : dx)) / total).ratio };
      } else {
        a.change = { rect: kind === "move" ? floatBox(a.bounds.width, a.bounds.height, { ...box, x: box.x + dx, y: box.y + dy }) : resizeFloat(a.bounds, box, dx, dy) };
        if (kind === "move") preview(a, ev.clientX, ev.clientY, true);
      }
      store.set({ transient: a.change });
    };
    const up = ev => { if (owns(ev) && active === a) finish(true); }, stop = ev => { if (owns(ev) && active === a) cancel(); };
    win.addEventListener("pointermove", move); win.addEventListener("pointerup", up); win.addEventListener("pointercancel", stop); el.addEventListener("lostpointercapture", stop);
    a.off = () => {
      win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); win.removeEventListener("pointercancel", stop); el.removeEventListener("lostpointercapture", stop);
      try { el.releasePointerCapture(pointerId); } catch { /* not captured */ }
    };
    try { el.setPointerCapture(pointerId); } catch { /* window listeners still own the physical drag */ }
  };
  const over = e => {
    const a = active; if (!a || a.kind !== "dock") return;
    if (!valid(a)) { cancel(); return; }
    preview(a, e.clientX, e.clientY);
    if (a.target) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; }
  };
  const dropped = e => {
    const a = active; if (!a || a.kind !== "dock") return;
    over(e);
    if (active !== a) return;
    if (a.target) { e.preventDefault(); e.stopPropagation(); finish(true); } else cancel();
  };
  const key = e => {
    const a = active; if (!a || e.isComposing || modified(e)) return;
    if (!valid(a)) { cancel(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); return; }
    if (a.kind !== "keyboard") return;
    if (e.key === "Tab") { cancel(); return; }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); return; }
    const step = e.shiftKey ? 64 : 16;
    const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0, dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
    if (!dx && !dy) return;
    e.preventDefault(); e.stopPropagation();
    const box = a.change?.rect || a.box;
    a.change = { rect: a.mode === "move" ? floatBox(a.bounds.width, a.bounds.height, { ...box, x: box.x + dx, y: box.y + dy }) : resizeFloat(a.bounds, box, dx, dy) };
    store.set({ transient: a.change });
  };
  const outside = () => { if (active?.kind === "keyboard") cancel(); };
  const focus = e => { if (active?.kind === "keyboard" && !active.root.querySelector(`[data-pane="${active.id}"]`)?.contains(e.target)) cancel(); };
  const off = controller.subscribe(() => { if (active && !valid(active)) cancel(); });
  doc.addEventListener("dragover", over, true); doc.addEventListener("drop", dropped, true); doc.addEventListener("dragend", cancel, true); doc.addEventListener("keydown", key, true); doc.addEventListener("pointerdown", outside, true); doc.addEventListener("focusin", focus, true);
  win.addEventListener("blur", cancel); win.addEventListener("resize", cancel);
  return {
    store, cancel,
    dragStart(name, e, id) {
      if (!isSafeInstanceName(name) || !e.dataTransfer) return false;
      if (id) controller.focus(id);
      const a = make("dock", id); if (!a) return false;
      a.name = name;
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("application/x-agend-pane", name); } catch { /* source ownership is local, not read from the transfer */ }
      return true;
    },
    dragEnd: cancel,
    sashDown: e => down("sash", null, e),
    floatDown: (kind, id, e) => down(kind, id, e),
    sashKey(e) {
      const w = controller.current(), rect = getRoot()?.getBoundingClientRect();
      if (!w || !rect || modified(e) || !usable() || w.layout === "float") return;
      const size = splitSize(rect.width, rect.height, w.layout, w.ratio), total = size.first + size.second, step = e.shiftKey ? 64 : 16;
      let first;
      if (e.key === "Home") first = size.min; else if (e.key === "End") first = size.max; else if (e.key === "Enter") first = total / 2;
      else if (e.key === (w.layout === "stack" ? "ArrowDown" : "ArrowRight")) first = size.first + step;
      else if (e.key === (w.layout === "stack" ? "ArrowUp" : "ArrowLeft")) first = size.first - step;
      else return;
      e.preventDefault(); controller.geometry({ ratio: splitSize(rect.width, rect.height, w.layout, first / total).ratio }); store.set({ announcement: geometryText("resized") });
    },
    keyboard(mode, id) {
      const w = controller.current(); if (!w || w.layout !== "float" || w.floating !== id || !["move", "resize"].includes(mode)) return;
      controller.focus(id); const a = make("keyboard", id); if (!a) return;
      a.mode = mode; a.box = floatBox(a.bounds.width, a.bounds.height, w.rect);
      store.set({ keyboard: { mode, id } }); a.root.querySelector(`[data-pane="${id}"] h1`)?.focus();
    },
    close() {
      if (!alive) return; cancel(); alive = false; off();
      doc.removeEventListener("dragover", over, true); doc.removeEventListener("drop", dropped, true); doc.removeEventListener("dragend", cancel, true); doc.removeEventListener("keydown", key, true); doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("focusin", focus, true);
      win.removeEventListener("blur", cancel); win.removeEventListener("resize", cancel);
    },
  };
}

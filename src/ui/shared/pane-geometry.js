// #3637: display geometry shared by the split sash, docking preview and in-page float.
export const SASH = 8;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function splitSize(width, height, layout, ratio = .5) {
  const total = Math.max(0, finite(layout === "stack" ? height : width, 0) - SASH);
  const min = Math.min(layout === "stack" ? 320 : 360, total / 2);
  const first = clamp(total * finite(ratio, .5), min, total - min);
  return { first, second: total - first, ratio: total ? first / total : .5, min, max: total - min };
}
export function floatBox(width, height, box) {
  width = Math.max(0, finite(width, 0)); height = Math.max(0, finite(height, 0));
  const w = clamp(finite(box?.width, 560), Math.min(420, width), width);
  const h = clamp(finite(box?.height, 460), Math.min(360, height), height);
  return { x: clamp(finite(box?.x, width - w - 16), 0, width - w), y: clamp(finite(box?.y, height - h - 96), 0, height - h), width: w, height: h };
}
export function dropZone(rect, x, y) {
  const dx = x - rect.left, dy = y - rect.top;
  if (![dx, dy, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;
  const edges = [["left", dx / Math.min(72, rect.width * .22)], ["right", (rect.width - dx) / Math.min(72, rect.width * .22)],
    ["top", dy / Math.min(72, rect.height * .22)], ["bottom", (rect.height - dy) / Math.min(72, rect.height * .22)]];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] <= 1 ? edges[0][0] : "center";
}
export function dropBox(rect, zone) {
  const { left, top, width, height } = rect;
  return { left: left + (zone === "right" ? width / 2 : 0), top: top + (zone === "bottom" ? height / 2 : 0),
    width: ["left", "right"].includes(zone) ? width / 2 : width, height: ["top", "bottom"].includes(zone) ? height / 2 : height };
}

// Screenshot-only classifier for the sample's three colours. Include both ends of the
// actual gesture, and recognise antialiased/fading particles blended over the BEFORE
// pixel. Unchanged UI colours, transparency alone and packets never count as paint.
export function particlePaintDelta(before, after, start, end = start) {
  if (before.width !== after.width || before.height !== after.height) throw Error('capture dimensions changed');
  const palette = [[255, 49, 124], [0, 199, 206], [255, 152, 0]];
  let added = 0;
  const left = Math.max(0, Math.floor(Math.min(start.x, end.x) - 100)), right = Math.min(after.width, Math.ceil(Math.max(start.x, end.x) + 100));
  const top = Math.max(0, Math.floor(Math.min(start.y, end.y) - 100)), bottom = Math.min(after.height, Math.ceil(Math.max(start.y, end.y) + 100));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const a = (y * before.width + x) * before.channels, b = (y * after.width + x) * after.channels;
    const base = [before.data[a], before.data[a + 1], before.data[a + 2]], delta = base.map((v, i) => after.data[b + i] - v);
    const change = delta.reduce((n, v) => n + v * v, 0);
    if (change < 144) continue;
    if (palette.some(color => {
      const direction = color.map((v, i) => v - base[i]), magnitude = direction.reduce((n, v) => n + v * v, 0);
      if (!magnitude) return false;
      const alpha = direction.reduce((n, v, i) => n + v * delta[i], 0) / magnitude;
      return alpha >= 0.05 && alpha <= 1.05 && direction.reduce((n, v, i) => n + (delta[i] - alpha * v) ** 2, 0) <= Math.min(27, change * 0.04);
    })) added++;
  }
  return { added };
}

/** Native smoke verdict only. Packets and pixels are independent requirements. */
export function pointerCaseFailure(c) {
  if (c.optional === true || c.outsideRegion === true) return null;
  // The sample fades in 1.2s. A stalled capture cannot establish timely visual response.
  if (c.capture && [c.capture.before, c.capture.after].some(ms => !Number.isFinite(ms) || ms > 1000)) return 'invalid capture: exceeded particle observation budget';
  if (c.status?.startsWith('FINDING') || c.status?.startsWith('FAIL')) return c.status;
  if (c.expected === 'sparks' || c.expected === 'trail' || c.expected === 'trail capped at30Hz') {
    const accepted = c.expected === 'sparks'
      ? c.packets?.some(p => p.kind === 'click' || p.kind === 'down')
      : c.packets?.filter(p => p.kind === 'move' && (p.buttons & 1) !== 0).length >= 2;
    if (!accepted) return 'required pointer input absent';
    if (!(c.paint?.added > 15)) return c.paint?.added > 0 ? 'insufficient particle paint evidence' : 'required particle paint absent';
  }
  return null;
}

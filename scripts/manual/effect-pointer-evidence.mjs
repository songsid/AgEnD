/** Native smoke verdict only. Packets and pixels are independent requirements. */
export function pointerCaseFailure(c) {
  if (c.optional === true || c.outsideRegion === true) return null;
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

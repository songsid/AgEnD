import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { checkEffectEntry } from '../src/web-effect-bundle.js';
// @ts-ignore private native-recipe verdict helper, outside the emitted application.
import { pointerCaseFailure, particlePaintDelta } from '../scripts/manual/effect-pointer-evidence.mjs';
const directory = new URL('../docs/examples/click-sparks/', import.meta.url);
const code = readFileSync(new URL('worker.js', directory), 'utf8');
function worker() {
  const handlers: Record<string, (e: Record<string, unknown>) => void> = {};
  let next: ((time: number) => void) | null = null, ready = 0, painted = 0, scheduled = 0;
  const ctx = { setTransform() {}, clearRect() { painted = 0; }, beginPath() {}, arc() {}, fill() { painted++; } };
  const canvas = { width: 400, height: 300, getContext: () => ctx };
  runInNewContext(code, { agend: { canvas, on(kind: string, fn: typeof handlers[string]) { handlers[kind] = fn; }, frame(fn: typeof next) { next = fn; scheduled++; }, ready() { ready++; } } });
  return { canvas, ready: () => ready, scheduled: () => scheduled, pending: () => next !== null, draw(time: number) { const fn = next; next = null; fn?.(time); return painted; }, pointer(kind: string, buttons: number, ts = 1000) { handlers.pointer({ kind, buttons, ts, x: 80, y: 90 }); }, env(width: number, height: number) { handlers.env({ width, height }); } };
}
describe('reusable CW1 click sparks example', () => {
  it('validates the exact two-file package and remains small', () => {
    expect(readdirSync(directory).sort()).toEqual(['effect.json', 'worker.js']);
    const result = checkEffectEntry(new Map(['effect.json', 'worker.js'].map(name => [name, readFileSync(new URL(name, directory))])));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.wants).toEqual(['pointer']);
    expect(result.manifest.regions).toEqual(['chat', 'page', 'box']);
    expect(result.bytes).toBeLessThan(4096);
  });
  it('announces ready once and does not paint without input', () => { const w = worker(); expect(w.ready()).toBe(1); expect(w.scheduled()).toBe(0); expect(w.draw(0)).toBe(0); });
  it('plain movement and wheel do not spawn particles', () => { const w = worker(); w.pointer('move', 0); w.pointer('wheel', 0); expect(w.draw(0)).toBe(0); });
  it('a click alone spawns a burst', () => { const w = worker(); w.pointer('click', 0); expect(w.draw(0)).toBe(24); });
  it('a click spawns a burst, deduping down+click within 180ms', () => { const w = worker(); w.pointer('down', 1); w.pointer('click', 0, 1010); expect(w.draw(0)).toBe(24); });
  it('a held movement starts a burst if down was coalesced away, then a trail', () => { const w = worker(); w.pointer('move', 1); expect(w.draw(0)).toBe(27); w.pointer('move', 1, 1050); expect(w.draw(34)).toBe(30); });
  it('paints at most thirty frames a second', () => { const w = worker(); w.pointer('click', 0); expect(w.draw(0)).toBe(24); w.pointer('move', 1, 1050); expect(w.draw(16)).toBe(24); expect(w.draw(34)).toBe(27); });
  it('keeps a strict 128-particle cap under sustained input', () => { const w = worker(); for (let n = 0; n < 1000; n++) w.pointer('move', 1, n * 20); expect(w.draw(0)).toBe(128); });
  it('ages particles out and always schedules another frame', () => { const w = worker(); w.pointer('click', 0); w.draw(0); for (let n = 1; n < 40; n++) w.draw(n * 50); expect(w.draw(2000)).toBe(0); expect(w.pending()).toBe(false); });
  it('caps its backing bitmap while retaining CSS coordinates', () => { const w = worker(); w.env(1366, 900); expect([w.canvas.width, w.canvas.height]).toEqual([512, 337]); });
  it('resizes using host env CSS dimensions', () => { const w = worker(); w.env(200, 100); expect([w.canvas.width, w.canvas.height]).toEqual([200, 100]); });
});

describe('native pointer evidence refuses missing input or paint', () => {
  const image = (width = 400, height = 4) => ({ width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(40) });
  it('counts faded sample colours at the far end of a drag, independently of input packets', () => {
    const before = image(), after = image();
    for (let x = 205; x < 225; x++) after.data.set([126, 44, 74], x * 3); // 40% pink over dark grey
    expect(particlePaintDelta(before, after, { x: 100, y: 2 }).added).toBe(0);
    expect(particlePaintDelta(before, after, { x: 100, y: 2 }, { x: 200, y: 2 }).added).toBe(20);
    expect(before.data.every(v => v === 40)).toBe(true);
  });
  it('counts each antialiased sample colour over light and dark backgrounds', () => {
    for (const background of [30, 240]) for (const color of [[255, 49, 124], [0, 199, 206], [255, 152, 0]]) {
      const before = image(), after = image(); before.data.fill(background); after.data.fill(background);
      for (let x = 105; x < 125; x++) after.data.set(color.map(v => Math.round(background + (v - background) * 0.2)), x * 3);
      expect(particlePaintDelta(before, after, { x: 100, y: 2 }).added).toBe(20);
    }
  });
  it('unchanged coloured UI and absent paint never count, and selection blue is not a particle', () => {
    const before = image(), after = image();
    for (let x = 105; x < 125; x++) { before.data.set([255, 49, 124], x * 3); after.data.set([255, 49, 124], x * 3); }
    for (let x = 130; x < 150; x++) after.data.set([30, 90, 200], x * 3);
    expect(particlePaintDelta(before, after, { x: 100, y: 2 }).added).toBe(0);
  });
  it('neutral glyph antialiasing and gray background changes are not faded particles', () => {
    for (const base of [40, 240]) {
      const before = image(), after = image(); before.data.fill(base); after.data.fill(base);
      for (let x = 105; x < 125; x++) after.data.set([base - 10, base - 10, base - 10], x * 3);
      expect(particlePaintDelta(before, after, { x: 100, y: 2 }).added).toBe(0);
    }
  });
  it.each([
    [[33, 33, 33], [41, 64, 91]],
    [[33, 33, 33], [39, 63, 92]],
    [[255, 255, 255], [194, 218, 247]],
  ])('rejects actual selection-only RGB pairs from the original WebKit captures', (base, selected) => {
    const before = image(), after = image();
    for (let x = 0; x < before.width * before.height; x++) { before.data.set(base, x * 3); after.data.set(selected, x * 3); }
    expect(particlePaintDelta(before, after, { x: 100, y: 2 }).added).toBe(0);
  });
  it('refuses mismatched screenshot sizes rather than inventing paint', () => {
    expect(() => particlePaintDelta(image(), image(401), { x: 100, y: 2 })).toThrow('capture dimensions changed');
  });
  it.each(['sparks', 'trail', 'trail capped at30Hz'])('%s needs real particles independently of packets', expected => {
    const packets = expected === 'sparks' ? [{ kind: 'click', buttons: 1 }] : [{ kind: 'move', buttons: 1 }, { kind: 'move', buttons: 1 }];
    expect(pointerCaseFailure({ expected, packets, paint: { added: 16 } })).toBeNull();
    expect(pointerCaseFailure({ expected, packets, paint: { added: 0 } })).toBe('required particle paint absent');
    expect(pointerCaseFailure({ expected, packets, paint: { added: 14 } })).toBe('insufficient particle paint evidence');
    expect(pointerCaseFailure({ expected, packets: [], paint: { added: 100 } })).toBe('required pointer input absent');
  });
  it('a late screenshot cannot establish timely particle paint even when pixels are present', () => {
    const c = { expected: 'sparks', packets: [{ kind: 'click' }], paint: { added: 100 }, capture: { before: 20, after: 1001 } };
    expect(pointerCaseFailure(c)).toBe('invalid capture: exceeded particle observation budget');
    expect(pointerCaseFailure({ ...c, capture: { before: 1001, after: 20 } })).toBe('invalid capture: exceeded particle observation budget');
    expect(pointerCaseFailure({ ...c, capture: { before: 20, after: 1000 } })).toBeNull();
  });
  it('never reports a core finding as pass', () => { expect(pointerCaseFailure({ status: 'FINDING:no-burst-packet' })).toBeTruthy(); });
  it('keeps explicitly optional touch and out-of-region diagnostics separate', () => {
    expect(pointerCaseFailure({ optional: true, status: 'FINDING:touch-cancelled' })).toBeNull();
    expect(pointerCaseFailure({ outsideRegion: true, expected: 'sparks', packets: [] })).toBeNull();
  });
});

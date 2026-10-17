import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { checkEffectEntry } from '../src/web-effect-bundle.js';
const directory = new URL('../docs/examples/click-sparks/', import.meta.url);
const code = readFileSync(new URL('worker.js', directory), 'utf8');
function worker() {
  const handlers: Record<string, (e: Record<string, unknown>) => void> = {};
  let next: (time: number) => void = () => {}, ready = 0, painted = 0;
  const ctx = { clearRect() { painted = 0; }, beginPath() {}, arc() { painted++; }, fill() {} };
  const canvas = { width: 400, height: 300, getContext: () => ctx };
  runInNewContext(code, { agend: { canvas, on(kind: string, fn: typeof handlers[string]) { handlers[kind] = fn; }, frame(fn: typeof next) { next = fn; }, ready() { ready++; } } });
  return { canvas, ready: () => ready, draw(time: number) { next(time); return painted; }, pointer(kind: string, buttons: number, ts = 1000) { handlers.pointer({ kind, buttons, ts, x: 80, y: 90 }); }, env(width: number, height: number) { handlers.env({ width, height }); } };
}
describe('reusable CW1 click sparks example', () => {
  it('validates the exact two-file package and remains small', () => {
    const result = checkEffectEntry(new Map(['effect.json', 'worker.js'].map(name => [name, readFileSync(new URL(name, directory))])));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.wants).toEqual(['pointer']);
    expect(result.manifest.regions).toEqual(['chat', 'page', 'box']);
    expect(result.bytes).toBeLessThan(4096);
  });
  it('announces ready once and does not paint without input', () => { const w = worker(); expect(w.ready()).toBe(1); expect(w.draw(0)).toBe(0); });
  it('plain movement and wheel do not spawn particles', () => { const w = worker(); w.pointer('move', 0); w.pointer('wheel', 0); expect(w.draw(0)).toBe(0); });
  it('a click spawns a burst, deduping down+click within 180ms', () => { const w = worker(); w.pointer('down', 1); w.pointer('click', 0, 1010); expect(w.draw(0)).toBe(24); });
  it('a held movement starts a burst if down was coalesced away, then a trail', () => { const w = worker(); w.pointer('move', 1); expect(w.draw(0)).toBe(27); w.pointer('move', 1, 1050); expect(w.draw(16)).toBe(30); });
  it('keeps a strict 128-particle cap under sustained input', () => { const w = worker(); for (let n = 0; n < 1000; n++) w.pointer('move', 1, n * 20); expect(w.draw(0)).toBe(128); });
  it('ages particles out and always schedules another frame', () => { const w = worker(); w.pointer('click', 0); w.draw(0); for (let n = 1; n < 40; n++) w.draw(n * 50); expect(w.draw(2000)).toBe(0); });
  it('resizes using host env CSS dimensions', () => { const w = worker(); w.env(200, 100); expect([w.canvas.width, w.canvas.height]).toEqual([200, 100]); });
});

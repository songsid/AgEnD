// Types for fleet-office-dialogue.js (#2861): the Office's dialogue box — the page's module, read by tests.
export const DLG: { TEXT_MAX: number; FRESH_MS: number; HOLD_MS: number; FADE_MS: number; SLIDE_MS: number; WAIT_MS: number; CPS: number; MAX: number };
export interface DialogPerson { name: string; account: string | null }
export interface Conversation { id: number; instance: string; person: DialogPerson | null; text: string | null; reply: string | null; heardAt: number; answeredAt: number | null; shownAt: number | null; replyShownAt: number | null }
export interface DialogLayout {
  narrow: boolean; box: { x: number; y: number; w: number; h: number };
  portrait: { h: number; foot: number; maxW: number; left: number; right: number };
  pad: number; font: number; lineH: number; nameH: number; statusH: number; face: number; text: { x: number; y: number; w: number; lines: number };
}
export interface DialogStage { phase: "heard" | "working" | "answered"; speaker: "left" | "right"; slide: number; alpha: number; typedAt: number; done: boolean }
export function clip(text: unknown, max?: number): string;
export function createDialogue(): {
  heard(instance: string, person: DialogPerson | null, text: string | null, t: number): Conversation | null;
  answered(instance: string, text: string | null, t: number): Conversation | null;
  sweep(t: number, still?: boolean): boolean; list(): Conversation[]; size(): number; rev(): number; clear(): void;
};
export function pickFront(list: Conversation[], shown: (name: string) => boolean, asleep: (name: string) => boolean): { front: Conversation | null; more: number };
export function messageOf(m: unknown, serverNow: number): ({ kind: "heard"; instance: string; person: DialogPerson; text: string; files: boolean } | { kind: "answered"; instance: string; text: string; files: boolean }) | null;
export function talkOf(d: unknown): Array<{ instance: string; kind: "heard" | "answered"; at: number }>;
export function portraitState(state: string): "idle" | "working" | "needs";
export function portraitSrc(pack: unknown, who: { agent?: string; state?: string; account?: string | null } | null): string | null;
export function boxLayout(W: number, H: number): DialogLayout;
export function fitBox(L: DialogLayout, n: number, status: boolean): DialogLayout;
export function wrap(measure: (s: string) => number, text: string, maxW: number, max: number): string[];
export function typed(lines: string[], n: number): string[];
export function stageOf(c: Conversation, t: number, working: boolean, still: boolean): DialogStage;
export function boxColours(dialogBox: unknown, pal: Record<string, string>): { background: string; border: string; text: string; name: string; sub: string };
export function drawBox(ctx: unknown, v: unknown, t: number, env: unknown): boolean;
export function onBox(L: DialogLayout | null, stage: DialogStage | null, x: number, y: number): boolean;
export function createFaces(load?: (src: string) => unknown): (src: string, done?: () => void) => unknown;

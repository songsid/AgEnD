// Types for fleet-office-carousel.js (#4010): the Office view's carousel helpers — the page's module, read by tests.
export const CAROUSEL_ID: "*carousel";
export const INTERVAL_MIN: 15;
export const INTERVAL_MAX: 600;
export const INTERVAL_DEFAULT: 30;
export const INTERVALS: readonly number[];
export function carouselOk(stored: unknown): boolean;
export function intervalOk(n: unknown): number;
export function carouselIdsOk(ids: unknown, stored: unknown): string[];
export function carouselSavedOk(v: unknown): { ids: string[]; interval: number };
export function nextIndex(i: number, n: number): number;
export function prevIndex(i: number, n: number): number;
export function carouselKey(e: { key?: string; repeat?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null | undefined): "pause" | "next" | "prev" | null;
export function carouselHeld(el: { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null | undefined): boolean;

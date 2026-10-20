import type { Locale } from './utils';

/** A post's id is `<locale>/<file name>`; the file name is its address in both languages. */
export function noteSlug(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}

export function notePath(base: string, locale: Locale, slug?: string): string {
  const root = locale === 'en' ? `${base}/notes/` : `${base}/zh-tw/notes/`;
  return slug ? `${root}${slug}/` : root;
}

/** The same date in every language and time zone: the date written in the post (YYYY-MM-DD). */
export function formatNoteDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** #2275: the CW-only network graph. Shared ambient/motion, themes, widgets and CSS are deliberately absent. */
export function isCanvasWorkerHttpPath(path: string): boolean {
  if (path === "/effect-bootstrap" || path.startsWith("/effect-bootstrap/")) return true;
  if (/^\/ui\/(?:effects|effect-posters|effect-trials)(?:\/|$)/.test(path)) return true;
  if (!path.startsWith("/assets/") && !path.startsWith("/ui/js/")) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:effect-|effects-waker\.|app-effects\.|chat-effects\.|chat-effect-posters\.|settings-effects\.|settings-owner-effects\.|owner-effect-prefs\.)/.test(name);
}

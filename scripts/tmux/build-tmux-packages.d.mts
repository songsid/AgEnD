/** Types for `build-tmux-packages.mjs`. Node16 resolves a `.mjs` import to `.d.mts`. */
export type TmuxBuildInfo = { tmux: string; sha256: string; size: number };
export function tmuxSemver(tmuxVersion: string, repack?: string): string;
/** The SPDX licence of exactly the parts a target links (tmux-sources.json). */
export function licenseFor(target: string, sources?: unknown): string;
export function tmuxManifest(target: string, info: TmuxBuildInfo, repack?: string, sources?: unknown): {
  name: string; version: string; description: string; license: string; repository: { type: string; url: string };
  os: string[]; cpu: string[]; files: string[]; agendTmux: TmuxBuildInfo;
};

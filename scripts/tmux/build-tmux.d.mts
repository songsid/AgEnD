/** Types for `build-tmux.mjs`. Node16 resolves a `.mjs` import to `.d.mts`. */
export type TmuxSource = { version: string; url: string; sha256: string; license: string; licenseFile: string; platforms?: string[]; licenseOnly?: boolean };
export type TmuxSources = {
  sourceDateEpoch: number;
  tmux: TmuxSource; libevent: TmuxSource; ncurses: TmuxSource; utf8proc: TmuxSource; jemalloc: TmuxSource; musl: TmuxSource;
  terminfo: string[];
  toolchain: {
    alpine: { image: string; release: string; packages: Record<string, string> };
    darwin: { xcode: string; xcodeBuild: string; sdk: string; developerDir: string };
  };
  terminfoAliases?: Record<string, string>;
  [part: string]: unknown;
};
export const SOURCES_FILE: string;
export const TARGETS: string[];
export function readSources(file?: string): TmuxSources & Record<string, TmuxSource>;
export function partsFor(sources: TmuxSources, target: string): string[];
export function srcDirName(part: string, version: string): string;
export function stripCommand(target: string, env: Record<string, string | undefined>, run?: (cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => string): { cmd: string; args: string[] };
export function hostTarget(platform?: string, arch?: string): string | null;

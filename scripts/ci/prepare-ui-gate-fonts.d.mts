export interface UiGateFontPin {
  package: string;
  version: string;
  archive: string;
  url: string;
  digest: string;
  files: Record<string, string>;
  fontconfigRule: { path: string; digest: string };
  checks: Array<{ pattern: string; file: string; family: string }>;
}
export function prepareUiGateFonts(options: {
  cacheDir: string;
  outputDir: string;
  pin?: UiGateFontPin;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  run?: (file: string, args: string[], options: {
    encoding: "utf8";
    timeout: number;
    killSignal: "SIGKILL";
    env: NodeJS.ProcessEnv;
  }) => { status: number | null; signal?: string | null; error?: unknown; stdout?: string; stderr?: string };
}): {
  package: string;
  version: string;
  source: string;
  archiveDigest: string;
  fontconfig: string;
  files: Record<string, string>;
  matches: Array<{ pattern: string; family: string; style: string; digest: string }>;
};

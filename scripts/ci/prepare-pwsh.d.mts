export function preparePowerShell(options?: {
  run?: (file: string, args: string[], options: {
    stdio: "inherit";
    timeout: number;
    killSignal: "SIGKILL";
  }) => { status: number | null; signal?: string | null; error?: unknown };
  now?: () => number;
  log?: (line: string) => void;
}): void;

export function settleRefusalCleanup(options: {
  read(): { issued: boolean; outcomeKnown: boolean; stage: string; reason: string | null };
  click(): Promise<unknown>;
  wait(done: () => boolean): Promise<unknown>;
  reason: string;
}): Promise<string>;

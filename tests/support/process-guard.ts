import { createRequire } from "node:module";
const native = createRequire(import.meta.url)("./process-guard.cjs") as {
  install(): { takeViolations(): string[]; drainJournal(path: string): string[]; registerFixture(path: string): void };
  checkInvocation(file: string, args?: string[], env?: NodeJS.ProcessEnv, cwd?: string | URL | Buffer): void;
  scrubEnvironment(env: NodeJS.ProcessEnv): void;
};
export const processGuard = native.install();
export const checkTestProcess = native.checkInvocation;
export const scrubTestEnvironment = native.scrubEnvironment;
export const registerExecutableFixture = (path: string): void => processGuard.registerFixture(path);

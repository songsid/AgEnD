import { createRequire } from "node:module";

// The installer and runtime enforce the same root policy before writing credentials or operator sockets.
const { ensurePrivateHome } = createRequire(import.meta.url)("../launcher/private-home.cjs") as {
  ensurePrivateHome(dir: string, options?: { create?: boolean; label?: string; log?: (line: string) => void }): void;
};
export function ensureAgendHome(dir: string, options?: { create?: boolean; label?: string; log?: (line: string) => void }): void {
  ensurePrivateHome(dir, options);
}

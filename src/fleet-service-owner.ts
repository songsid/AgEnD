import { createRequire } from "node:module";
export const fleetServiceOwner = createRequire(import.meta.url)("../launcher/fleet-service-owner.cjs") as {
  updateRefusal(home: string, options?: { locale?: string }): string | null;
  restartRefusal(home: string, service: { unit: string; user: boolean }, options?: { locale?: string }): string | null;
};

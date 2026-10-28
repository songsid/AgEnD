import { createRequire } from "node:module";
export interface ServiceOwnerTarget { unit: string; user: boolean }
export interface ServiceOwnerState { kind: "none" | "managed" | "outside" | "unknown"; pid?: number; mainPid?: number; signature?: string }
export const fleetServiceOwner = createRequire(import.meta.url)("../launcher/fleet-service-owner.cjs") as {
  selectedService(): ServiceOwnerTarget | null;
  updateRefusal(home: string, options?: { locale?: string }): string | null;
  inspect(home: string, service: ServiceOwnerTarget): ServiceOwnerState;
  handoff(home: string, service: ServiceOwnerTarget, options: { locale: string; log(line: string): void }): Promise<boolean>;
  message(key: "ready" | "unconfirmed", state: { unit: string; pid?: number }, locale: string): string;
};

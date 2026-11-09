/**
 * the message the owner gets when a computer joins with a one-time install-command token. The token approves the computer by itself, so nobody is
 * standing at an approval button; this is the out-of-band "it happened" (General topic, the primary channel, or the web Notices of a web-only fleet, whichever
 * `notifyFleetError` finds), with what is needed to recognise the computer and to revoke it.
 *
 * The computer's name and hostname are what the computer itself said, so whoever holds a leaked command chose them. They are cut to plain characters and a
 * short length, shown inside quotation marks so they read as data and cannot continue the sentence around them, and a dot becomes a middle dot so a name that
 * looks like a domain is not turned into a link by the chat application. A name cannot carry a mention, a link, markup or a fake instruction into the owner's chat.
 */
import { t } from "./locale.js";
import type { RuntimeEnrollmentAuditEntry } from "./runtime-coordinator.js";
import type { RuntimeMachine } from "./runtime-protocol.js";

const plain = (value: string | undefined, fallback: string): string => {
  const text = (value ?? "").replace(/\./g, "\u00b7").replace(/[^A-Za-z0-9 \u00b7_-]/g, "?").replace(/\s+/g, " ").trim().slice(0, 40);
  return `"${text || fallback}"`;
};
/** Null when the entry is not a use, or its computer is gone. */
export function enrolledRuntimeNotice(entry: RuntimeEnrollmentAuditEntry, machine: Pick<RuntimeMachine, "name" | "hostname"> | null): string | null {
  if (entry.event !== "used" || !entry.machineId || !machine) return null;
  return t("runtime.enroll_joined", plain(machine.name, "?"), plain(machine.hostname, "?"), (entry.enrollmentId ?? "").slice(0, 8), entry.machineId.slice(0, 8));
}

/** Trusted process-owned input fence, shared by Fleet, daemon and exec producers. No model/config authority. */
export interface RequestContextAdmissionPort {
  /** Pure observation, for pump/claim eligibility. It must not count a poll as a producer arrival. */
  available(): boolean;
  /** An actual durable producer arrived without claiming input (for example an outbox admission). */
  arrived(): void;
  /** Retain at the owning producer until admission opens; false means that exact producer is no longer current. */
  wait(current: () => boolean): Promise<boolean>;
  /** Re-evaluate held producers after an owner/transport change; never opens admission by itself. */
  changed(): void;
  /** Scheduling notification only; subscribing is not an input arrival and grants no admission. */
  subscribe(listener: (available: boolean) => void): () => void;
}
/** The callback starts synchronously after the last availability check, including exec claim/journal creation. */
export async function runWithRequestContextAdmission<T>(port: RequestContextAdmissionPort, current: () => boolean,
  run: () => T): Promise<Awaited<T>> {
  for (;;) {
    if (!current()) throw Error("Input owner is no longer current");
    if (port.available()) return await run();
    if (!await port.wait(current)) throw Error("Input owner is no longer current");
  }
}

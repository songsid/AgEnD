/** Durable member outbox. Lost result/ACKs only repeat frozen metadata, never a writer input. */
import { HUB_EXPOSURE_REQUEST_CAPABILITY, type HubExposureRequest } from "../agent-catalog-model.js";
import type { HubMemberLink } from "../client.js";
import { HubMemberSharing } from "./sharing.js";
import { HubMemberSharingJournal } from "./sharing-journal.js";
import { sharingResult, sharingUndo } from "./sharing-result.js";
export class HubMemberSharingLink {
  private link: HubMemberLink | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private readonly options: { sharing: HubMemberSharing; journal: HubMemberSharingJournal; current(): boolean; failed(): void }) {}
  connected(link: HubMemberLink): void {
    if (this.closed || !this.options.current() || !link.current() || !link.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY)) return;
    this.link = link;
    if (!this.timer) { this.timer = setInterval(() => { void this.flush(); }, 3_000); this.timer.unref(); }
    void this.flush();
  }
  disconnected(): void { this.link = null; if (this.timer) clearInterval(this.timer); this.timer = null; }
  receive(id: string, value: HubExposureRequest, link: HubMemberLink): void {
    if (this.link !== link || !this.current(link)) return;
    // The socket receive queue must remain free to deliver this operation's ACK.
    void this.options.sharing.apply(id, value, () => this.current(link)).then(() => this.flush()).catch(() => this.options.failed());
  }
  private current(link: HubMemberLink): boolean {
    return !this.closed && this.options.current() && this.link === link && link.current() && link.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY);
  }
  flush(): Promise<void> {
    return this.running ??= this.pump().catch(() => { this.options.failed(); }).finally(() => { this.running = null; });
  }
  private async pump(): Promise<void> {
    const link = this.link;
    if (!link || !this.current(link)) return;
    for (let record of this.options.journal.pending()) {
      if (!this.current(link)) return;
      if (!record.finalNoticeDurable) {
        record = await this.options.sharing.apply(record.id, record.request, () => this.current(link));
        if (!this.current(link)) return;
      }
      if (!record.resultAcked) {
        const ack = await link.exchange({ v: 1, type: "exposure.request-result", requestId: record.id,
          linkEpoch: link.linkEpoch, payload: sharingResult(record) }, "exposure.request-ack");
        if (!this.current(link) || ack.type !== "exposure.request-ack" || !ack.payload.ok) return;
        this.options.journal.acknowledge(record.id);
      }
      record = this.options.journal.read(record.id)!;
      if (record.undoId && !record.undoAcked && record.undoNoticeDurable) {
        const ack = await link.exchange({ v: 1, type: "exposure.undo", requestId: record.undoId,
          linkEpoch: link.linkEpoch, payload: sharingUndo(record) }, "exposure.undo-result");
        if (!this.current(link) || ack.type !== "exposure.undo-result" || !ack.payload.ok) return;
        this.options.journal.acknowledge(record.id, true);
      }
    }
  }
  close(): void { this.closed = true; this.disconnected(); }
}

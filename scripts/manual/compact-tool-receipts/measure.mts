import { readFileSync } from "node:fs";
import { compactDeliveryStatus, compactSendAck } from "../../../src/tool-receipt-output.js";
const [receiptPath, ackPath] = process.argv.slice(2);
if (!receiptPath || !ackPath) throw Error("Usage: node --import tsx scripts/manual/compact-tool-receipts/measure.mts <delivery-status.json> <send-ack.json>");
const before = readFileSync(receiptPath, "utf8"), ack = readFileSync(ackPath, "utf8");
const page = JSON.parse(before), accepted = JSON.parse(ack);
const compare = (a: string, b: string) => ({ beforeBytes: Buffer.byteLength(a), compactBytes: Buffer.byteLength(b), reductionPercent: +(100 * (1 - Buffer.byteLength(b) / Buffer.byteLength(a))).toFixed(1) });
const detail = JSON.stringify(compactDeliveryStatus(page, true)), ackDetail = JSON.stringify(compactSendAck(accepted, true));
if (detail !== JSON.stringify(page) || ackDetail !== JSON.stringify(accepted)) throw Error("detail changed the old object");
// No content, excerpts, actors, account identifiers or queried values are printed.
console.log({ delivery_status: compare(before, JSON.stringify(compactDeliveryStatus(page))), send_ack: compare(ack, JSON.stringify(compactSendAck(accepted, false, true))), detailRoundtrips: true });

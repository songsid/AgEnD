import { readFileSync } from 'node:fs';
import { agentUsage, agentUsageReport } from '../../../src/usage/agent-output.js';
// Read-only, already-captured tool responses. Never refresh a vendor or launch a CLI.
const [usagePath, reportPath] = process.argv.slice(2);
if (!usagePath || !reportPath) throw Error('Usage: node --import tsx scripts/manual/usage-agent-compact/measure.mts <get_usage.json> <get_usage_report.json>');
const before = readFileSync(usagePath, 'utf8');
const payload = JSON.parse(before);
const compact = JSON.stringify(agentUsage(payload, false, Date.parse(payload.fetchedAt)));
const detail = JSON.stringify(agentUsage(payload, true));
const reportBefore = readFileSync(reportPath, 'utf8');
const old = JSON.parse(reportBefore);
const row = ({ basis, ...rest }: any) => rest;
const source = { ...old, rows: old.rows.map(row), totals: row(old.totals) };
const reportAfter = JSON.stringify({ ...agentUsageReport(source, 10), more: old.more });
const reportDetail = JSON.stringify({ ...agentUsageReport(source, 10, true), more: old.more });
const counts = (a: string, b: string) => ({ beforeBytes: Buffer.byteLength(a), compactBytes: Buffer.byteLength(b), reductionPercent: +(100*(1-Buffer.byteLength(b)/Buffer.byteLength(a))).toFixed(1) });
const result = { capturedAt: payload.fetchedAt, providers: payload.providers.length, get_usage: counts(before, compact), get_usage_detail_roundtrip: detail===before, get_usage_report: counts(reportBefore, reportAfter), get_usage_report_detail_roundtrip: reportDetail===reportBefore };
// Equivalent key ordering is not part of the JSON object contract.
if (JSON.stringify(JSON.parse(detail)) !== JSON.stringify(payload)) throw Error('detail mismatch');
if (JSON.stringify(JSON.parse(reportDetail)) !== JSON.stringify(old)) throw Error('report detail mismatch');
console.log(result);

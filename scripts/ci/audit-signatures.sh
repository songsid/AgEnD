#!/usr/bin/env bash
# Verify npm registry signatures in one install tree (#2528).
# Invalid signatures, invalid attestations, mixed findings, operational
# failures, and unparseable output fail the job.
# Missing-only findings are printed and do not fail. That is our policy:
# npm 10 exits 1 for missing as well as invalid (lib/utils/verify-signatures.js).
# Usage: audit-signatures.sh <dir>
set -euo pipefail
DIR="${1:?directory}"
cd "$DIR"

stdout="$(mktemp)"
stderr="$(mktemp)"
trap 'rm -f "$stdout" "$stderr"' EXIT

set +e
npm audit signatures --json >"$stdout" 2>"$stderr"
code=$?
set -e

if [[ -s "$stderr" ]]; then
  cat "$stderr" >&2
fi

node --input-type=module - "$stdout" "$code" "$DIR" <<'NODE'
import fs from "node:fs";

const stdoutPath = process.argv[2];
const code = Number(process.argv[3]);
const dir = process.argv[4];
const raw = fs.readFileSync(stdoutPath, "utf8");

function writeRaw() {
  if (!raw.trim()) return;
  process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
}

function fail(msg) {
  writeRaw();
  console.error(msg);
  process.exit(1);
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const body = parseJson(raw);
if (body == null || typeof body !== "object" || Array.isArray(body)) {
  fail(`unparseable npm audit signatures output in ${dir} (exit ${code})`);
}
if (body.error) {
  const detail = typeof body.error === "object"
    ? JSON.stringify(body.error)
    : String(body.error);
  fail(`npm audit signatures failed in ${dir}: ${detail}`);
}
if (!Array.isArray(body.invalid) || !Array.isArray(body.missing)) {
  fail(`unparseable npm audit signatures output in ${dir} (exit ${code})`);
}

const invalid = body.invalid;
const missing = body.missing;

if (invalid.length > 0) {
  writeRaw();
  console.error(`invalid signatures or attestations in ${dir}: ${invalid.length}`);
  process.exit(1);
}

if (missing.length > 0) {
  writeRaw();
  console.error(`missing signatures reported in ${dir} (reported, not a failure): ${missing.length}`);
  process.exit(0);
}

if (code !== 0) {
  fail(`npm audit signatures failed in ${dir} (exit ${code}, no invalid or missing entries)`);
}

writeRaw();
process.exit(0);
NODE

# Evidence-only scan repair

Gitleaks8.24.3 reported two generic-api-key matches in source digest maps at the historical Team head. Every map value was verified against its recorded Git source blob; no credential was present. Current maps use an explicit sha256-to-paths-v1 encoding. Decode by inverting each digest-to-paths entry; the original map canonical digest and exact inverse equality are recorded in verification.json.

Only the two exact historical commit/path/rule/line fingerprints are exempted. No wildcard or general rule exception is added. Runtime, tests, harness and all32 original PNGs are unchanged. This repair requires fresh exact-head CI, with no repeat browser, native or mutation campaign.

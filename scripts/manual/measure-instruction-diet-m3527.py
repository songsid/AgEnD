#!/usr/bin/env python3
"""Count synthetic snapshots with tiktoken==0.12.0/o200k_base; no model calls."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import tiktoken

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
before, after = [json.loads(path.read_text()) for path in (args.before, args.after)]
encoder = tiktoken.get_encoding("o200k_base")
rows = {}
for name in before["text"]:
    old, new = before["text"][name], after["text"][name]
    a, b = len(encoder.encode(old)), len(encoder.encode(new))
    rows[name] = {"before": a, "after": b, "delta": b-a,
                  "beforeSha256": hashlib.sha256(old.encode()).hexdigest(),
                  "afterSha256": hashlib.sha256(new.encode()).hexdigest()}
for name in ("legacyPrompt", "workerPrompt", "legacyCatalog", "deltaEn", "deltaZh"):
    assert before["text"][name] == after["text"][name], name
assert "persona-emoji:" not in after["text"]["restrictedCatalog"]
assert "web-appearance:" not in after["text"]["restrictedCatalog"]
assert "Use set_display_name" not in after["text"]["restrictedPrompt"]
for name in ("firstBriefEn", "firstBriefZh"):
    assert after["text"][name].startswith(before["text"][name] + "\n"), name
for name, prompt in (("restrictedUnnamedWithCatalog", "restrictedPrompt"),
                     ("restrictedNamedWithCatalog", "restrictedNamedPrompt")):
    a, b = [len(encoder.encode(snapshot["text"][prompt] + "\n\n" + snapshot["text"]["restrictedCatalog"]))
            for snapshot in (before, after)]
    rows[name] = {"before": a, "after": b, "delta": b-a}
report = {"tokenizer": {"package": "tiktoken", "version": importlib.metadata.version("tiktoken"), "encoding": "o200k_base"},
          "beforeHead": before["head"], "afterHead": after["head"],
          "rows": rows, "scope": "Synthetic workflow-disabled prompts and name/description skill catalogue; not provider billing. Skill bodies and backend-specific catalogue wrappers/paths are excluded. Combined rows are tokenized as combined text, not summed."}
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({name: {k:v for k,v in row.items() if k in ("before", "after", "delta")} for name,row in rows.items()}, ensure_ascii=False))

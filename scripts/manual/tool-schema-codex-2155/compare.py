"""Every parameter whose type codex changed or lost, comparing AgEnD's declared tool schemas (tools-<label>.json, beside
the body log) with the declarations in the first request codex sent (body-<label>.log). No output lines = none."""
import json, os, sys
body_path = sys.argv[1]
body = json.loads(open(body_path).readline())
conv = {x["name"]: x["parameters"] for n in body["tools"] if n.get("type") == "namespace" and n["name"] == "mcp__agend" for x in n["tools"]}
orig = {t["name"]: t["inputSchema"] for t in json.load(open(body_path.replace("body-", "tools-").replace(".log", ".json")))}
diffs = []
def tset(s):
    if not isinstance(s, dict): return set()
    if "type" in s: return {s["type"]} if isinstance(s["type"], str) else set(s["type"])
    for k in ("anyOf", "oneOf"):
        if k in s: return set().union(*[tset(b) for b in s[k]])
    return {"(none)"}
def cmp(o, c, path, tool):
    if tset(o) != tset(c): diffs.append(f"{tool} {path}: declared {sorted(tset(o))} -> codex {sorted(tset(c))}")
    if not (isinstance(o, dict) and isinstance(c, dict)): return
    if "prefixItems" in o: diffs.append(f"{tool} {path}: prefixItems -> codex items {json.dumps(c.get('items'))}")
    if isinstance(o.get("items"), dict): cmp(o["items"], c.get("items") or {}, path + "[]", tool)
    for k, v in (o.get("properties") or {}).items():
        cv = (c.get("properties") or {}).get(k)
        if cv is None: diffs.append(f"{tool} {path}.{k}: dropped by codex")
        else: cmp(v, cv, f"{path}.{k}", tool)
    for key in ("anyOf", "oneOf"):
        if key in o and key in c:
            for i, (ob, cb) in enumerate(zip(o[key], c[key])): cmp(ob, cb, f"{path}.{key}[{i}]", tool)
        elif key in o: diffs.append(f"{tool} {path}: {key} -> codex {json.dumps(c)[:160]}")
for name, o in orig.items():
    if name not in conv: diffs.append(f"{name}: not sent")
    else: cmp(o, conv[name], "", name)
print(f"{len(orig)} declared, {len(conv)} sent, {len(diffs)} changed")
for d in diffs: print(d)

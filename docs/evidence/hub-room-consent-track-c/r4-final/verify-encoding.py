from pathlib import Path
import json,subprocess,hashlib
root=Path(__file__).resolve().parent
proof=json.loads((root/"receipt-encoding.json").read_text())
def decode(v):
    if isinstance(v,list): return [decode(x) for x in v]
    if not isinstance(v,dict): return v
    if set(v)=={"sha256ToPaths"}:
        out={}
        for digest,paths in v["sha256ToPaths"].items():
            for path in paths:
                assert path not in out
                out[path]=digest
        return out
    return {("idempotencyKey" if k=="idempotencyId" else k):decode(x) for k,x in v.items() if k!="evidenceEncoding"}
for row in proof["changes"]:
    old=subprocess.check_output(["git","show",proof["incomingHead"]+":"+row["path"]])
    current=Path(row["path"]).read_bytes()
    assert hashlib.sha256(old).hexdigest()==row["beforeSha256"]
    assert hashlib.sha256(current).hexdigest()==row["afterSha256"]
    assert decode(json.loads(current))==json.loads(old)
print(f"{len(proof['changes'])} exact receipt round trips PASS")

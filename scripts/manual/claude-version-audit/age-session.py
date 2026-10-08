# Backdate every timestamp in a Claude session transcript by N hours, so --continue sees an old session (the resume menu's trigger).
import sys,json,datetime,glob
hours=float(sys.argv[1])
for f in sys.argv[2:]:
    out=[]
    for line in open(f):
        try: o=json.loads(line)
        except Exception: out.append(line); continue
        ts=o.get("timestamp")
        if isinstance(ts,str):
            t=datetime.datetime.fromisoformat(ts.replace("Z","+00:00"))-datetime.timedelta(hours=hours)
            o["timestamp"]=t.isoformat().replace("+00:00","Z")
        out.append(json.dumps(o)+"\n")
    open(f,"w").write("".join(out))

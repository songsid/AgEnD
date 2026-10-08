# Every literal / literal regex run in claude-code.ts, counted in two binaries: a predicate whose text changed shows up here.
import sys,re
src=open(sys.argv[1]).read()
b1=open(sys.argv[2],'rb').read(); b2=open(sys.argv[3],'rb').read()
cands=set()
for m in re.finditer(r'"((?:[^"\\\n]|\\.){8,200})"|\'((?:[^\'\\\n]|\\.){8,200})\'|`((?:[^`\\$]|\\.){8,200})`', src):
    t=m.group(1) or m.group(2) or m.group(3)
    if re.search(r'[A-Za-z]{3}.*\s.*[A-Za-z]{2}', t): cands.add(t.replace('\\"','"').replace("\\'","'"))
for m in re.finditer(r'/((?:[^/\\\n]|\\.){6,300})/[gimsuy]*', src):
    for run in re.split(r'\\[sSdDwWbB]|[\[\]\(\)\|\?\*\+\{\}\^\$]|\\.', m.group(1)):
        run=run.strip()
        if len(run)>=7 and re.search(r'[A-Za-z]{4}',run) and ' ' in run: cands.add(run)
present=changed=0
for c in sorted(cands):
    n1,n2=b1.count(c.encode()),b2.count(c.encode())
    if n1 or n2: present+=1
    if n1!=n2: changed+=1; print(f"COUNT {n1:>4} → {n2:<4} {c[:110]}")
    elif n1 and not n2: print("GONE", c)
print(f"checked {len(cands)} predicate literals; in the binaries {present}; count changed {changed}")

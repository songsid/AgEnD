# Literal strings only in one version, minifier placeholders normalised, filtered to dialog/permission/error vocabulary.
import sys,re
K=re.compile(r'(?i)permission|trust|bypass|dangerous|approve|allow|do you want|proceed|resume|summar|mcp server|esc to|enter to|interrupt|queued|rate limit|overloaded|api error|login|sign in|oauth|exit|background|continue|retry|\u276f|yes,|no,|don.t ask')
def lits(f):
    d=open(f,'rb').read(); s=set()
    for m in re.finditer(rb'"([^"\\\n\x00]{6,240})"|`([^`\\\x00]{6,400})`|\'([^\'\\\n\x00]{6,240})\'',d):
        t=(m.group(1) or m.group(2) or m.group(3))
        try: t=t.decode('utf8')
        except: continue
        t=re.sub(r'\$\{[^}]*\}','${}',t)
        if K.search(t) and ' ' in t: s.add(t)
    return s
a,b=lits(sys.argv[1]),lits(sys.argv[2])
for t in sorted(a-b): print("ONLY", sys.argv[1], ":", t[:220].replace("\n","⏎"))
for t in sorted(b-a): print("ONLY", sys.argv[2], ":", t[:220].replace("\n","⏎"))
print(len(a),len(b),len(a-b),len(b-a))

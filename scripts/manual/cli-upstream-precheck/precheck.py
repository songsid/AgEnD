#!/usr/bin/env python3
"""Static precheck of an upstream CLI release against the text AgEnD's detectors match on.

    python3 -I scripts/manual/cli-upstream-precheck/precheck.py <backend> <old> <new>

<old> and <new> are what check-cli-versions.sh --download fetched (or a host install): a native binary, an npm
.tgz, a .tar.gz, a .zip, or a directory of any of those. Every regular file inside is read as bytes — archives are
read in memory, member by member, nothing is extracted to disk and nothing is ever executed. This file imports only
the standard library modules that read files and parse text (a test holds the exact list), so running it cannot start
a CLI or reach the network.

For each literal of the backend in manifest.json (generated from src/: build-manifest.ts) it counts the occurrences
in both artifacts, then looks for prompt-like strings that only the new artifact has. The last line is the verdict:

    PRECHECK: MAJOR | MINOR | NONE

MAJOR  a literal that the old artifact has is missing from the new one; or a new prompt-like string sits near a known
       detector literal (a dialog, approval, trust, onboarding, resume, error, chrome surface); or the old artifact
       shows too few of the backend's literals for this check to see the CLI at all (compressed or encoded text).
MINOR  counts changed, a literal appeared, or new prompt-like strings elsewhere.
NONE   nothing of the above.
"""
import bisect
import gzip
import json
import os
import re
import sys
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_MEMBER = 1 << 30                 # one file or archive member read at most (1 GiB)
NEAR = 600                           # bytes: a new prompt this close to a known literal is on that literal's surface
MAX_OFFSETS = 64                     # offsets kept per literal per file (enough to place nearby strings)
MIN_COVERAGE = 3                     # fewer literals than this found in the old artifact: it cannot be checked

TEXT = rb"[^\x00-\x1f\"'`\\]"        # a character inside a string: no control character, quote or backslash
PROMPTS = [
    rb"Do you want (?:to )?" + TEXT + rb"{2,120}?\?",
    rb"Would you like (?:to )?" + TEXT + rb"{2,120}?\?",
    rb"Are you sure" + TEXT + rb"{0,120}?\?",
    rb"(?:Press|press|Hit|hit) (?:Enter|enter|Esc|esc|Escape|Tab|tab|Space|space|[Cc]trl\+[A-Za-z]|[A-Za-z0-9])(?: again)? to " + TEXT + rb"{2,60}",
    rb"(?:Allow|Approve|Trust|Accept|Deny|Reject|Grant) " + TEXT + rb"{2,100}?\?",
    rb"\((?:y/n|Y/n|y/N|yes/no)\)",
    rb"Yes, (?:and |allow|I trust|I accept|proceed|continue|don't ask)" + TEXT + rb"{0,60}",
    rb"No, (?:and |exit|cancel|tell|keep)" + TEXT + rb"{0,60}",
    rb"(?:[Ee]sc|[Cc]trl\+[Cc]) to (?:interrupt|cancel|exit|go back)",
    rb"[Rr]etrying in " + TEXT + rb"{1,40}",
    rb"(?:[Rr]ate limit(?:ed)?|[Uu]sage limit) " + TEXT + rb"{2,80}",
    rb"(?:[Rr]esume|[Cc]ontinue) (?:this |the |from |previous )" + TEXT + rb"{2,80}",
]
PROMPT_RE = re.compile(b"|".join(b"(?:" + p + b")" for p in PROMPTS))
QUIET_SURFACES = {"other"}           # a new prompt near only these does not make the release MAJOR
INTERP_RE = re.compile(r"\$\{[^}]*\}?")
SENTENCE_END_RE = re.compile(r"[.?!]|:(?=\S)")
GLUED_RE = re.compile(r"[a-z][A-Z]")
KEY_CHARS = 60
TAIL_RE = re.compile(r"\s\S{1,2}$")
PUNCT_TAIL_RE = re.compile(r"([.?!:])[A-Za-z0-9]{1,2}$")
CUT_RE = re.compile(r"[\x00-\x1f\x7f\ufffd].*", re.S)


def normalize(raw):
    """A prompt-like string as compared across releases: minified names inside ${…} do not count, nor what runs on
    past the string's end (a control character or undecodable byte)."""
    text = CUT_RE.sub("", raw.decode("utf-8", "replace"))
    text = INTERP_RE.sub("${}", text)
    text = " ".join(text.split()).strip()
    # A native binary (Rust, Go) keeps strings back to back with no separator: "press R to continue here.retry …". The
    # first sentence is the prompt; what follows is a neighbour that may change with any build. And at most KEY_CHARS.
    m = SENTENCE_END_RE.search(text)
    if m:
        text = text[:m.end()]
    # The same, with no punctuation at the join: "Yes, proceed" + a header byte + "Do you trust …" reads "proceednDo".
    # Cut where a lower-case letter runs into an upper-case one, and drop that glued word (it may carry the byte).
    # Capped first, so a neighbour beyond the cap never changes where the text is cut.
    text = text[:KEY_CHARS]
    m = GLUED_RE.search(text)
    if m:
        text = text[:m.start() + 1]
        text = text.rsplit(" ", 1)[0] if " " in text else text
    # A string table (Bun, JSC) puts the next entry's header right after a string, and a header byte can be printable:
    # "…allow access to 9", "…a different file.B". Trailing tokens of one or two characters are not compared (all of
    # them, so "…access to" and "…access to 9" read the same).
    text = PUNCT_TAIL_RE.sub(r"\1", text)
    while True:
        shorter = TAIL_RE.sub("", text)
        if shorter == text:
            return text
        text = shorter


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    print("REASON: the precheck could not run: " + msg)
    print("PRECHECK: MAJOR")
    sys.exit(3)


def blobs(path):
    """(name, bytes) for every regular file in `path`: a file, an archive (read in memory), or a directory."""
    if os.path.islink(path):
        fail("not following a symlink: " + path)
    if os.path.isdir(path):
        for root, dirs, files in os.walk(path, followlinks=False):
            dirs.sort()
            for f in sorted(files):
                p = os.path.join(root, f)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                for item in file_blobs(p, os.path.relpath(p, path)):
                    yield item
    elif os.path.isfile(path):
        for item in file_blobs(path, os.path.basename(path)):
            yield item
    else:
        fail("no such file or directory: " + path)


def file_blobs(p, name):
    if os.path.getsize(p) > MAX_MEMBER:
        print("note: skipped (over 1 GiB): " + name, file=sys.stderr)
        return
    if tarfile.is_tarfile(p):
        with tarfile.open(p, "r:*") as tar:
            for m in tar:
                if not m.isreg() or m.size > MAX_MEMBER:
                    continue
                fh = tar.extractfile(m)
                if fh is not None:
                    yield name + "!" + m.name, fh.read()
        return
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > MAX_MEMBER:
                    continue
                yield name + "!" + info.filename, z.read(info)
        return
    with open(p, "rb") as fh:
        data = fh.read()
    if data[:2] == b"\x1f\x8b":
        try:
            data = gzip.decompress(data)
        except (OSError, EOFError):
            pass
    yield name, data


def forms(text):
    """The byte forms a literal may take in an artifact: UTF-8, UTF-16LE, and JSON-escaped (minified JS)."""
    out = [text.encode("utf-8"), text.encode("utf-16-le")]
    esc = json.dumps(text)[1:-1].encode("ascii")
    if esc not in out:
        out.append(esc)
    return out


def scan(path, literals, want_offsets):
    """Counts per literal, prompt-like strings found, and (for the new artifact) where they sit near literals."""
    counts = [0] * len(literals)
    prompts = {}                     # candidate → surfaces it was found near
    files = 0
    size = 0
    lit_forms = [forms(l["text"]) for l in literals]
    for name, data in blobs(path):
        files += 1
        size += len(data)
        offsets = []                 # (offset, literal index), for placing prompts
        for i, fs in enumerate(lit_forms):
            n = 0
            for f in fs:
                c = data.count(f)
                n += c
                if c and want_offsets:
                    at = data.find(f)
                    kept = 0
                    while at >= 0 and kept < MAX_OFFSETS:
                        offsets.append((at, i))
                        kept += 1
                        at = data.find(f, at + 1)
            counts[i] += n
        offsets.sort()
        keys = [o for o, _ in offsets]
        for m in PROMPT_RE.finditer(data):
            cand = normalize(m.group(0))
            if len(cand) < 12:
                continue
            near = prompts.setdefault(cand, set())
            if want_offsets and keys:
                lo = bisect.bisect_left(keys, m.start() - NEAR)
                hi = bisect.bisect_right(keys, m.end() + NEAR)
                for _, i in offsets[lo:hi]:
                    near.add(i)
    return counts, prompts, files, size


def main(argv):
    if len(argv) < 4 or argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0 if len(argv) > 1 and argv[1] in ("-h", "--help") else 2)
    backend, old, new = argv[1], argv[2], argv[3]
    manifest_path = os.path.join(HERE, "manifest.json")
    if "--manifest" in argv:
        manifest_path = argv[argv.index("--manifest") + 1]
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if backend not in manifest["backends"]:
        fail("unknown backend %r (one of: %s)" % (backend, ", ".join(sorted(manifest["backends"]))))
    literals = manifest["backends"][backend]["literals"]

    c_old, p_old, f_old, s_old = scan(old, literals, False)
    c_new, p_new, f_new, s_new = scan(new, literals, True)

    def where(l):
        return "%s:%s %s" % (l["file"], l["line"], l["symbol"])

    print("precheck %s (manifest %s, %d literals)" % (backend, manifest.get("source", "?"), len(literals)))
    print("  old: %s — %d file(s), %.1f MB" % (old, f_old, s_old / 1e6))
    print("  new: %s — %d file(s), %.1f MB" % (new, f_new, s_new / 1e6))

    present = [i for i, n in enumerate(c_old) if n]
    missing = [i for i in present if not c_new[i]]
    changed = [i for i in present if c_new[i] and c_new[i] != c_old[i]]
    appeared = [i for i, n in enumerate(c_old) if not n and c_new[i]]
    print("\nliterals in the old artifact: %d of %d (the rest are AgEnD's own text, or this CLI never had them)" % (len(present), len(literals)))

    def show(title, idx):
        print("\n%s: %d" % (title, len(idx)))
        for i in idx:
            l = literals[i]
            print("  [%s] %d -> %d  %s   (%s)" % (l["surface"], c_old[i], c_new[i], json.dumps(l["text"][:100], ensure_ascii=False), where(l)))

    show("MISSING (in old, not in new)", missing)
    show("COUNT CHANGED", changed)
    show("APPEARED (not in old, in new)", appeared)

    fresh = sorted(c for c in p_new if c not in p_old)
    on_surface, elsewhere = [], []
    for c in fresh:
        surfaces = sorted({literals[i]["surface"] for i in p_new[c]})
        loud = [s for s in surfaces if s not in QUIET_SURFACES]
        (on_surface if loud else elsewhere).append((c, loud or surfaces, sorted(p_new[c])[:3]))
    print("\nNEW PROMPT-LIKE STRINGS near a known detector literal: %d" % len(on_surface))
    for c, surfaces, near in on_surface:
        print("  [%s] %s   near %s" % (",".join(surfaces), json.dumps(c[:140], ensure_ascii=False), "; ".join(json.dumps(literals[i]["text"][:40], ensure_ascii=False) for i in near)))
    print("\nNEW PROMPT-LIKE STRINGS elsewhere: %d" % len(elsewhere))
    for c, _, _ in elsewhere[:40]:
        print("  " + json.dumps(c[:140], ensure_ascii=False))
    if len(elsewhere) > 40:
        print("  … %d more" % (len(elsewhere) - 40))
    gone_prompts = sorted(c for c in p_old if c not in p_new)
    print("\nPROMPT-LIKE STRINGS gone in the new artifact: %d" % len(gone_prompts))
    for c in gone_prompts[:20]:
        print("  " + json.dumps(c[:140], ensure_ascii=False))

    reasons_major, reasons_minor = [], []
    if len(present) < MIN_COVERAGE:
        reasons_major.append("only %d of the backend's literals were found in the old artifact: this check cannot see the CLI's text (compressed or encoded?) — audit by hand" % len(present))
    if missing:
        reasons_major.append("%d detector literal(s) missing: %s" % (len(missing), "; ".join("[%s] %s" % (literals[i]["surface"], json.dumps(literals[i]["text"][:60], ensure_ascii=False)) for i in missing[:5])))
    if on_surface:
        reasons_major.append("%d new prompt-like string(s) on a known surface: %s" % (len(on_surface), "; ".join("[%s] %s" % (",".join(s), json.dumps(c[:60], ensure_ascii=False)) for c, s, _ in on_surface[:5])))
    if changed:
        reasons_minor.append("%d literal count(s) changed" % len(changed))
    if appeared:
        reasons_minor.append("%d literal(s) appeared" % len(appeared))
    if elsewhere:
        reasons_minor.append("%d new prompt-like string(s) away from known literals" % len(elsewhere))
    verdict = "MAJOR" if reasons_major else "MINOR" if reasons_minor else "NONE"
    print("")
    for r in reasons_major + reasons_minor:
        print("REASON: " + r)
    print("PRECHECK: " + verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

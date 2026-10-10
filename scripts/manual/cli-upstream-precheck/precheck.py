#!/usr/bin/env python3
"""Static precheck of an upstream CLI release against the text AgEnD's detectors match on.

    python3 -I scripts/manual/cli-upstream-precheck/precheck.py <backend> <old> <new>

<old> and <new> are what check-cli-versions.sh --download fetched (or a host install): a native binary, an npm
.tgz, a .tar.gz, a .zip, a gzip file, or a directory of any of those. Every regular file inside is read as bytes —
archives are read in memory, member by member, nothing is extracted to disk and nothing is ever executed. This file
imports only the standard library modules that read files and parse text (a test holds the exact list), so running
it cannot start a CLI or reach the network.

For each literal of the backend in manifest.json (generated from src/: build-manifest.ts) it counts the occurrences
in both artifacts, then looks for prompt-like strings that only the new artifact has. The last line is the verdict:

    PRECHECK: MAJOR | MINOR | NONE

MAJOR  a literal that the old artifact has is missing from the new one; or a new prompt-like string sits near a known
       detector literal (a dialog, approval, trust, onboarding, resume, error, chrome surface); or the old artifact
       shows too few of the backend's literals for this check to see the CLI at all; or either artifact could not be
       read in full (unreadable, too large, a broken archive or gzip); or the run failed. Never NONE by omission.
MINOR  counts changed, a literal appeared, or new prompt-like strings elsewhere (or only a neighbouring string changed).
NONE   nothing of the above.
"""
import bisect
import json
import os
import re
import sys
import tarfile
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_MEMBER = 1 << 30                 # one file or archive member, decompressed: at most this many bytes (1 GiB)
NEAR = 600                           # bytes: a new prompt this close to a known literal is on that literal's surface
MIN_COVERAGE = 3                     # fewer literals than this found in the old artifact: it cannot be checked
CHUNK = 1 << 20

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
UTF16_RUN_RE = re.compile(rb"(?:[\x20-\x7e]\x00){8,}")
QUIET_SURFACES = {"other"}           # a new prompt near only these does not make the release MAJOR
INTERP_RE = re.compile(r"\$\{[^}]*\}?")
CUT_RE = re.compile(r"[\x00-\x1f\x7f�].*", re.S)
# A Bun/JSC string table: each entry is followed by the next one's 4-byte length, high byte 0x80. When that length's
# low byte is printable it reads as the string's last character ("…allow access to 9" + "\x00\x00\x80").
BUN_HEADER = b"\x00\x00\x80"
# Markdown emphasis: a CLI's own dialogs never carry it; the docs and skills a binary embeds do.
MARKDOWN_RE = re.compile(r"\*\*")


class Incomplete(Exception):
    """A part of an artifact could not be read in full: the scan cannot vouch for it."""


def fail(msg, code=3):
    print("error: " + msg, file=sys.stderr)
    print("REASON: the precheck could not run: " + msg)
    print("PRECHECK: MAJOR")
    sys.exit(code)


def normalize(raw):
    """A prompt-like string as compared across releases: minified names inside ${…} do not count, nor what runs on
    past the string's end (a control character or undecodable byte). Nothing else is cut: a string that differs is a
    new string unless the comparison has evidence that only its neighbour changed (neighbour_only)."""
    text = CUT_RE.sub("", raw.decode("utf-8", "replace"))
    text = INTERP_RE.sub("${}", text)
    return " ".join(text.split()).strip()


def boundaries(text):
    """Where a native binary may have joined two strings with no separator: after sentence punctuation, or where a word
    that starts in lower case runs into an upper-case letter ("proceednDo", "errorCompaction" — never "OpenAI" or
    "GitHub", whose word starts in upper case)."""
    out = []
    for i in range(1, len(text)):
        if text[i - 1] in ".?!:":
            out.append(i)
        elif text[i].isupper() and i >= 3 and text[i - 3:i].isalpha() and text[i - 3:i].islower():
            word = text[:i].rsplit(" ", 1)[-1]
            if not any(ch.isupper() for ch in word):
                out.append(i)
    return out


def read_bounded(fh, limit, what):
    """Read a stream, refusing more than `limit` bytes (never reads past limit + 1)."""
    data = fh.read(limit + 1)
    if len(data) > limit:
        raise Incomplete("%s: more than %d bytes" % (what, limit))
    return data


def gunzip_bounded(data, limit, what):
    """Decompress gzip data without ever holding more than `limit` bytes of output (plus one chunk)."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = []
    size = 0
    buf = data
    try:
        while True:
            piece = d.decompress(buf, CHUNK)
            size += len(piece)
            if size > limit:
                raise Incomplete("%s: decompresses to more than %d bytes" % (what, limit))
            out.append(piece)
            if d.eof:
                break
            buf = d.unconsumed_tail
            if not buf and not piece:
                raise Incomplete("%s: truncated gzip" % what)
    except zlib.error as e:
        raise Incomplete("%s: broken gzip (%s)" % (what, e))
    return b"".join(out)


def blobs(path, limit, issues, notes):
    """(name, bytes) for every regular file in `path`: a file, an archive (read in memory), or a directory. What cannot be
    read in full goes to `issues` (the verdict is then MAJOR); links that are not followed go to `notes`."""
    if os.path.islink(path):
        fail("not following a symlink: " + path)
    if os.path.isdir(path):
        def onerror(err):
            issues.append("cannot list %s (%s)" % (err.filename, err.strerror))
        for root, dirs, files in os.walk(path, followlinks=False, onerror=onerror):
            dirs.sort()
            for d in dirs:
                if os.path.islink(os.path.join(root, d)):
                    notes.append("link not followed: " + os.path.relpath(os.path.join(root, d), path))
            for f in sorted(files):
                p = os.path.join(root, f)
                rel = os.path.relpath(p, path)
                if os.path.islink(p):
                    notes.append("link not followed: " + rel)
                    continue
                if not os.path.isfile(p):
                    continue
                for item in file_blobs(p, rel, limit, issues):
                    yield item
    elif os.path.isfile(path):
        for item in file_blobs(path, os.path.basename(path), limit, issues):
            yield item
    else:
        fail("no such file or directory: " + path)


def file_blobs(p, name, limit, issues):
    try:
        if os.path.getsize(p) > limit:
            raise Incomplete("%s: larger than %d bytes" % (name, limit))
        if tarfile.is_tarfile(p):
            with tarfile.open(p, "r:*") as tar:
                for m in tar:
                    if not m.isreg():
                        continue
                    if m.size > limit:
                        issues.append("%s!%s: larger than %d bytes" % (name, m.name, limit))
                        continue
                    fh = tar.extractfile(m)
                    if fh is None:
                        issues.append("%s!%s: cannot be read" % (name, m.name))
                        continue
                    yield name + "!" + m.name, read_bounded(fh, limit, name + "!" + m.name)
            return
        if zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for info in z.infolist():
                    if info.is_dir():
                        continue
                    if info.file_size > limit:
                        issues.append("%s!%s: larger than %d bytes" % (name, info.filename, limit))
                        continue
                    with z.open(info) as fh:
                        yield name + "!" + info.filename, read_bounded(fh, limit, name + "!" + info.filename)
            return
        with open(p, "rb") as fh:
            data = read_bounded(fh, limit, name)
        if data[:2] == b"\x1f\x8b":
            data = gunzip_bounded(data, limit, name)
        yield name, data
    except Incomplete as e:
        issues.append(str(e))
    except (OSError, EOFError, tarfile.TarError, zipfile.BadZipFile, zlib.error, RuntimeError) as e:
        issues.append("%s: %s" % (name, e))


def forms(text):
    """The byte forms a literal may take in an artifact: UTF-8, UTF-16LE, and JSON-escaped (minified JS)."""
    out = [text.encode("utf-8"), text.encode("utf-16-le")]
    esc = json.dumps(text)[1:-1].encode("ascii")
    if esc not in out:
        out.append(esc)
    return out


def prompt_matches(data):
    """(offset, raw bytes) of every prompt-like string, in UTF-8 and in UTF-16LE text, at its byte offset."""
    for m in PROMPT_RE.finditer(data):
        raw = m.group(0)
        if data[m.end():m.end() + 3] == BUN_HEADER and len(raw) > 1:
            raw = raw[:-1]                 # the next entry's length byte, not part of the string
        yield m.start(), raw
    for run in UTF16_RUN_RE.finditer(data):
        text = run.group(0).decode("utf-16-le", "replace").encode("utf-8", "replace")
        for m in PROMPT_RE.finditer(text):
            yield run.start() + 2 * m.start(), m.group(0)


def scan(path, literals, want_offsets, limit):
    """Counts per literal, prompt-like strings (→ the literals they sit near), and what could not be read."""
    counts = [0] * len(literals)
    prompts = {}
    files = 0
    size = 0
    issues, notes = [], []
    lit_forms = [forms(l["text"]) for l in literals]
    for name, data in blobs(path, limit, issues, notes):
        files += 1
        size += len(data)
        offsets = []                 # (offset, literal index): every occurrence, for placing prompts
        for i, fs in enumerate(lit_forms):
            for f in fs:
                c = data.count(f)
                counts[i] += c
                if c and want_offsets:
                    at = data.find(f)
                    while at >= 0:
                        offsets.append((at, i))
                        at = data.find(f, at + 1)
        offsets.sort()
        keys = [o for o, _ in offsets]
        for start, raw in prompt_matches(data):
            cand = normalize(raw)
            if len(cand) < 12:
                continue
            near = prompts.setdefault(cand, set())
            if want_offsets and keys:
                lo = bisect.bisect_left(keys, start - NEAR)
                hi = bisect.bisect_right(keys, start + len(raw) + NEAR)
                for _, i in offsets[lo:hi]:
                    near.add(i)
    return counts, prompts, files, size, issues, notes


def present_in(path, needles, limit):
    """Which of `needles` (bytes) occur anywhere in the artifact (a read-only pass over the old artifact)."""
    found = set()
    issues, notes = [], []
    for _, data in blobs(path, limit, issues, notes):
        for n in needles:
            if n not in found and n in data:
                found.add(n)
    return found, issues


def neighbour_candidates(cand, old_prompts):
    """(head, tail) splits of `cand` at a boundary where the head begins an old prompt-like string: if the tail (the
    neighbour) also exists in the old artifact, only the neighbouring string changed."""
    out = []
    for i in boundaries(cand):
        head, tail = cand[:i], cand[i:].strip()
        if len(head) < 12 or len(tail) < 6:
            continue
        if any(o.startswith(head) for o in old_prompts):
            out.append((head, tail[:24].encode("utf-8")))
    return out


def load_manifest(path, backend):
    try:
        with open(path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as e:
        fail("cannot read the manifest %s (%s)" % (path, e))
    backends = manifest.get("backends") if isinstance(manifest, dict) else None
    if not isinstance(backends, dict) or not backends:
        fail("the manifest has no backends")
    if backend not in backends:
        fail("unknown backend %r (one of: %s)" % (backend, ", ".join(sorted(backends))))
    literals = backends[backend].get("literals") if isinstance(backends[backend], dict) else None
    if not isinstance(literals, list) or not literals:
        fail("the manifest has no literals for %s" % backend)
    for l in literals:
        if not isinstance(l, dict) or not isinstance(l.get("text"), str) or not l["text"] or not isinstance(l.get("surface"), str):
            fail("the manifest's %s literals are malformed" % backend)
        for k in ("file", "symbol"):
            l.setdefault(k, "?")
        l.setdefault("line", 0)
    return manifest, literals


def main(argv):
    if len(argv) > 1 and argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    args = list(argv[1:])
    manifest_path = os.path.join(HERE, "manifest.json")
    limit = MAX_MEMBER
    if "--manifest" in args:
        i = args.index("--manifest")
        if i + 1 >= len(args):
            fail("--manifest needs a path", 2)
        manifest_path = args[i + 1]
        del args[i:i + 2]
    if "--max-member" in args:          # tests only: a small bound, to show that it holds
        i = args.index("--max-member")
        try:
            limit = int(args[i + 1])
        except (IndexError, ValueError):
            fail("--max-member needs a byte count", 2)
        del args[i:i + 2]
    if len(args) != 3:
        fail("usage: precheck.py <backend> <old> <new> [--manifest PATH]", 2)
    backend, old, new = args
    manifest, literals = load_manifest(manifest_path, backend)

    c_old, p_old, f_old, s_old, i_old, n_old = scan(old, literals, False, limit)
    c_new, p_new, f_new, s_new, i_new, n_new = scan(new, literals, True, limit)

    def where(l):
        return "%s:%s %s" % (l["file"], l["line"], l["symbol"])

    print("precheck %s (manifest %s, %d literals)" % (backend, manifest.get("source", "?"), len(literals)))
    print("  old: %s — %d file(s), %.1f MB" % (old, f_old, s_old / 1e6))
    print("  new: %s — %d file(s), %.1f MB" % (new, f_new, s_new / 1e6))
    for side, issues, notes in (("old", i_old, n_old), ("new", i_new, n_new)):
        for x in issues:
            print("  INCOMPLETE (%s): %s" % (side, x))
        for x in notes[:10]:
            print("  note (%s): %s" % (side, x))

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

    # A new prompt-like string, unless the old artifact shows it is an old one beside a different neighbour.
    fresh = sorted(c for c in p_new if c not in p_old)
    splits = {c: neighbour_candidates(c, p_old) for c in fresh}
    needles = {t for s in splits.values() for _, t in s}
    found, i_third = present_in(old, needles, limit) if needles else (set(), [])
    on_surface, elsewhere, neighbour, docs = [], [], [], []
    for c in fresh:
        same = next((h for h, t in splits[c] if t in found), None) if not i_third else None
        if same is not None:
            neighbour.append((c, same))
            continue
        if MARKDOWN_RE.search(c):            # "**bold**": documentation the binary embeds, not a screen it paints
            docs.append(c)
            continue
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
    print("\nNEW PROMPT-LIKE STRINGS in documentation text (markdown **bold**): %d" % len(docs))
    for c in docs[:20]:
        print("  " + json.dumps(c[:140], ensure_ascii=False))
    print("\nPROMPT KEPT, ONLY ITS NEIGHBOURING STRING CHANGED: %d" % len(neighbour))
    for c, same in neighbour[:20]:
        print("  %s   (kept: %s)" % (json.dumps(c[:140], ensure_ascii=False), json.dumps(same, ensure_ascii=False)))
    gone_prompts = sorted(c for c in p_old if c not in p_new)
    print("\nPROMPT-LIKE STRINGS gone in the new artifact: %d" % len(gone_prompts))
    for c in gone_prompts[:20]:
        print("  " + json.dumps(c[:140], ensure_ascii=False))

    reasons_major, reasons_minor = [], []
    incomplete = ["old: " + x for x in i_old] + ["new: " + x for x in i_new] + ["old (neighbour check): " + x for x in i_third]
    if incomplete:
        reasons_major.append("the scan was incomplete, so it cannot vouch for this release — %s" % "; ".join(incomplete[:4]))
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
    if docs:
        reasons_minor.append("%d new prompt-like string(s) in documentation text" % len(docs))
    if neighbour:
        reasons_minor.append("%d prompt-like string(s) kept, beside a neighbouring string that changed" % len(neighbour))
    verdict = "MAJOR" if reasons_major else "MINOR" if reasons_minor else "NONE"
    print("")
    for r in reasons_major + reasons_minor:
        print("REASON: " + r)
    print("PRECHECK: " + verdict)
    return 4 if verdict == "MAJOR" and incomplete else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except BaseException as e:            # any failure ends with a verdict line, never a bare traceback
        fail("%s: %s" % (type(e).__name__, e))

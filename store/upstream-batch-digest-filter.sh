#!/usr/bin/env bash
# upstream-batch-digest-filter.sh -- strips arbitrary `git log` output down to commit
# hash+subject lines ONLY (card efe4aa40, MikroB decision komment 23269, point 2).
#
# WHY THIS EXISTS: the upstream-batch-digest local-llm category (card 1ebc26c2) may fall back to
# the Gemini heavy second-opinion path (f0b3b674) when the local model exhausts its attempts. The
# f0b3b674 path's whole safety case (card a92e9913/C4) rests on sending ONLY task text to Gemini,
# never file content/diff -- but a real "upstream batch" is naturally `git log --stat` or `-p`
# output, which carries file paths, insertion/deletion counts and diff hunks. MikroB's decision on
# the efe4aa40 RETHINK (komment 23267/23269): upstream-batch-digest MAY use the Gemini fallback,
# but ONLY commit hash + subject -- the --stat/filelist/diff must NEVER leave this filter, and the
# filtering happens BEFORE the local attempt (not only before Gemini), so the local draft and the
# Gemini fallback see the exact same, already-safe text.
#
# USAGE: pipe raw `git log` output in, get only "<hash> <subject>" lines out.
#   git log --stat <range> | upstream-batch-digest-filter.sh
#
# Exits 1 (no stdout) if NOTHING survives the filter -- an empty/all-stripped input must never
# silently become an empty-but-"successful" call (fail-closed: no draft rather than a blind pass).
set -euo pipefail

out="$(python3 -I -c '
import re, sys

# A commit line (git log --oneline / `git log --format=%h %s`): a 7-40 char lowercase hex hash,
# whitespace, then a non-empty subject. Nothing else is allowed through.
#
# Cybersec NO-GO (F1, komment 23461): reading physical lines (split on "\n" only) lets a single
# physical line smuggle a --stat path / diff hunk header past the regex via an embedded logical
# line boundary (\r, \v, \f, \x1c-\x1e, \x85, U+2028/2029) that the regex treats as ordinary text.
# str.splitlines() splits on ALL of those boundaries (not just "\n"), so each resulting element is
# a genuine single logical line before the regex ever sees it -- a hash alone on its own line
# (the smuggled remainder after the boundary) fails the "hash + whitespace + subject" shape and is
# dropped, instead of being re-admitted as part of the matched commit line.
COMMIT_RE = re.compile(r"^[0-9a-f]{7,40}\s+\S.*$")

# RedHat NO-GO K1 (komment 23553, bb1f9f6f delta-gate): -c without -I resolves sys.path[0] to the
# calling agent cwd and still honours PYTHONPATH, so a planted re.py (or a PYTHONPATH entry) in
# the working directory can silently shadow the stdlib re module used above and defeat the whole
# filter. -I (isolated mode) ignores both, mirroring the same fix already applied to the
# gemini-offload-call.sh redactor and seged-hivo.py/gemini-agy-call.sh (card f6f67dff R3).
for line in sys.stdin.read().splitlines():
    if COMMIT_RE.match(line):
        print(line)
')"

if [[ -z "${out// }" ]]; then
  echo "upstream-batch-digest-filter: no commit hash+subject lines survived (nothing safe to send)" >&2
  exit 1
fi
printf '%s\n' "$out"

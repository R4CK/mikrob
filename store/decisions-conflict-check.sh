#!/usr/bin/env bash
# decisions-conflict-check.sh -- card 4a769a34 (Trail-ötlet 2, Peti 11527/11530): before a landing
# pushes, a diff can silently touch a file a past DECISIONS.md entry made a deliberate call about
# (a security gate, a NOT-ADOPTED refusal, a "this stays as-is" business decision) without anyone
# who reviews the diff knowing that entry exists. This is the structural helper for the 5th code-
# quality rule (CLAUDE.md "Funkció-tulajdonos jelölés" / working-function protection): surface the
# PAST decision next to the CURRENT diff, so a reviewer sees it instead of having to remember it or
# grep for it by hand.
#
# FIRST ROUND IS REPORT-ONLY (card text, verbatim): "Jelenlegi implementációban csak jelez, nem
# blokkolja automatikusan a merge-t." This function therefore always returns 0 -- it has no REFUSED
# path, unlike decisions-tail-append-guard.sh or landing-gate-verdict-check.sh. Its only job is to
# print the matched entries so they land in the same landing-log a human or agent is already reading
# (stdout, not stderr -- this is not a warning about this script, it is information the diff needs).
#
# MATCHING IS A LITERAL SUBSTRING SEARCH, not a symbol-boundary check. CLAUDE.md's own code-quality
# rule 12 (identifier-boundary matching) is about PRESENCE/ABSENCE guards that can be gamed to pass
# -- this is the opposite shape: a report that can only ever OVER-report (extra noise, never a
# missed real hit) is safe here, because nothing downstream trusts it to gate anything. A
# false-positive costs a reviewer one extra line to skim; a false-negative costs nothing either,
# since this never replaces reading the diff itself.
#
# FIELD CAPTURE IS A HEURISTIC over the common entry shape seen across the file (a line starting
# **Label:** followed by zero or more unlabeled continuation lines until the next blank line). Entries
# that do not follow this shape (free-form bold sub-headers instead of the five standard labels) are
# still found (the file-path substring match is over the WHOLE entry body, not just the labelled
# fields) -- only the quoted context under them may be thinner. Acceptable for a report-only aid.
#
# API (source this file to get the function):
#   decisions_conflict_report <decisions-file-content-via-stdin> <file1> [<file2> ...]
#     Reads the DECISIONS.md content to check from STDIN (so the caller decides which ref's version
#     to read -- normally the merge result, via `git cat-file blob <tip>:<file>`). Prints one block
#     per matched entry to stdout. Always returns 0.
#
# CLI:
#   decisions-conflict-check.sh --check-ref <repo> <tip-sha> <decisions-file> <file1> [<file2> ...]
#   decisions-conflict-check.sh --selftest
set -u

decisions_conflict_report() {
  local -a files=("$@")
  [ "${#files[@]}" -eq 0 ] && return 0
  awk -v files_str="$(printf '%s\n' "${files[@]}")" '
    BEGIN {
      nf = split(files_str, farr, "\n")
    }
    { lines[++n] = $0 }
    END {
      nh = 0
      for (i = 1; i <= n; i++) if (lines[i] ~ /^## /) hdr[++nh] = i
      hdr[nh + 1] = n + 1
      for (i = 1; i <= nh; i++) {
        start = hdr[i]; stop = hdr[i + 1] - 1
        body = ""
        for (j = start; j <= stop; j++) body = body lines[j] "\n"
        matched = ""
        for (fi = 1; fi <= nf; fi++) {
          f = farr[fi]
          if (f == "") continue
          if (index(body, f) > 0) matched = matched (matched == "" ? "" : ", ") f
        }
        if (matched != "") {
          print "----"
          print "Erintett fajl(ok): " matched
          print lines[start]
          capturing = 0
          for (j = start + 1; j <= stop; j++) {
            if (lines[j] ~ /^\*\*(Kontextus|Döntés|Miért|Ki döntött|Hivatkozás):/) {
              print lines[j]; capturing = 1; continue
            }
            if (capturing) {
              if (lines[j] == "") { capturing = 0; continue }
              print lines[j]
            }
          }
        }
      }
    }
  '
  return 0
}

# CLI DISPATCH ONLY WHEN EXECUTED, NEVER WHEN SOURCED (same guard as the sibling DECISIONS.md
# scripts -- BASH_SOURCE differs from $0 only when the file is read via `.`/`source`).
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-ref" ]; then
  repo="$2"; tip="$3"; decisions_file="$4"; shift 4
  git -C "$repo" cat-file blob "$tip:$decisions_file" 2>/dev/null | decisions_conflict_report "$@"
  exit 0
fi

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }

  fixture() {
    printf '%s\n' \
      '# Döntésnapló' \
      '' \
      '## 2026-01-01 -- első bejegyzés' \
      '' \
      '**Kontextus:** valami.' \
      '' \
      '**Döntés:** a src/web/channel-poller-reap.ts argv-réteg bent marad.' \
      '' \
      '**Miért:** biztonsági okból,' \
      'két sorban folytatva.' \
      '' \
      '**Ki döntött:** RedHat.' \
      '' \
      '**Hivatkozás:** kártya abc123.' \
      '' \
      '## 2026-01-02 -- második bejegyzés, másik fájlról' \
      '' \
      '**Döntés:** a src/db.ts prune-függvényei maradjanak kikapcsolva alapból.' \
      '' \
      '**Ki döntött:** Peti.'
  }

  # 1. a file referenced in entry 1 is matched, entry 2 is not.
  out="$(fixture | decisions_conflict_report src/web/channel-poller-reap.ts)"
  if echo "$out" | grep -q "első bejegyzés" && ! echo "$out" | grep -q "második bejegyzés"; then
    ok "matches only the entry whose body references the given file"
  else
    no "expected only entry 1 to match: $out"
  fi

  # 2. multi-line field continuation is captured, not just the label line.
  if echo "$out" | grep -q "két sorban folytatva"; then
    ok "continuation line under a label is captured"
  else
    no "continuation line should be captured: $out"
  fi

  # 3. a file touching no entry -> no output.
  out2="$(fixture | decisions_conflict_report src/totally-unrelated-file.ts)"
  if [ -z "$out2" ]; then
    ok "an unreferenced file produces no output"
  else
    no "an unreferenced file should produce nothing: $out2"
  fi

  # 4. multiple files can each match, and a single entry matching two files is reported once with
  # both named (not duplicated).
  out3="$(fixture | decisions_conflict_report src/web/channel-poller-reap.ts src/db.ts)"
  n_hdr="$(echo "$out3" | grep -c '^## ')"
  if [ "$n_hdr" -eq 2 ]; then
    ok "two files matching two different entries report both, once each"
  else
    no "expected exactly 2 matched entries, got $n_hdr: $out3"
  fi

  # 5. no files given -> no output, never errors.
  out4="$(fixture | decisions_conflict_report)"
  if [ -z "$out4" ]; then
    ok "no target files given produces no output"
  else
    no "no target files should produce nothing: $out4"
  fi

  # 6. empty DECISIONS.md content -> no output, never errors.
  out5="$(printf '' | decisions_conflict_report src/db.ts)"
  if [ -z "$out5" ]; then
    ok "empty decisions content produces no output"
  else
    no "empty decisions content should produce nothing: $out5"
  fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

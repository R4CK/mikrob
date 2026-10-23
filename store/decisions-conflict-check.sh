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
# CLOSED SILENT-MISS PATHS (card 40b5038f, WhiteHat GO follow-up on 4a769a34, comment 22988, F1a-c):
# the "can only over-report" claim above held for the MATCHING shape, but not for the CALLER's path
# list -- three ways a touched file could go completely unreported, no noise, nothing to skim past:
#   (a) a non-ASCII filename gets octal-quoted by `git diff --name-only` under the default
#       core.quotepath=true, so the literal path text never appears in the diff's own output --
#       decisions_conflict_diff_paths() below always runs with `-z` (NUL-terminated machine output),
#       which git documents as never quoting paths regardless of core.quotepath -- verified directly:
#       the same diff with `-z` alone already prints the raw UTF-8 bytes, `-c core.quotepath=false`
#       on top of `-z` is a no-op, so it is deliberately left out rather than kept as dead config.
#   (b) a renamed file's OLD path (what an existing DECISIONS.md entry would actually reference)
#       never appears in `--name-only` output, only the new path -- decisions_conflict_diff_paths()
#       uses `--name-status -M -z` and reports BOTH sides of an R/C record.
#   (c) a long diff's file list, previously passed to awk via `-v files_str="..."`, can exceed the
#       OS's execve() argument-length limit (ARG_MAX, ~128KB-2MB) and silently truncate or fail --
#       decisions_conflict_report() below instead writes the file list to a temp file and has awk
#       read it with `getline`, so the argv itself only ever carries a short path.
# F3 (same comment thread): the report used to read the MERGE RESULT's DECISIONS.md, so a landing's
# own freshly-appended entry could be quoted back as if it were an "earlier" decision. The caller is
# responsible for this one -- pass the PRE-DIFF ref's DECISIONS.md (the merge-base / BASE sha), never
# the merge result or HEAD. See the updated marveen-land.sh/mopsion-land.sh call sites.
# F2 (same thread, lower severity): unbounded output (measured: 1047 lines / 95KB for 5 common hub
# files against the real 587-entry DECISIONS.md) -- capped below via DECISIONS_CONFLICT_MAX_ENTRIES
# / DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY, with a final "... and N more" line instead of silently
# growing without bound.
#
# API (source this file to get the functions):
#   decisions_conflict_report <decisions-file-content-via-stdin> <file1> [<file2> ...]
#     Reads the DECISIONS.md content to check from STDIN (so the caller decides which ref's version
#     to read -- the PRE-DIFF ref, e.g. `git cat-file blob <base-sha>:<file>` -- see F3 above, never
#     the merge result). Prints one block per matched entry to stdout, capped (see F2 above). Always
#     returns 0. Env overrides: DECISIONS_CONFLICT_MAX_ENTRIES (default 20),
#     DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY (default 12).
#   decisions_conflict_diff_paths <repo> <base-sha> <tip-sha> [<pathspec> ...]
#     Prints one touched path per line -- both names for a rename/copy -- with quotepath disabled.
#     The caller-side half of the F1a/F1b fix above; feed its output to decisions_conflict_report.
#
# CLI:
#   decisions-conflict-check.sh --check-ref <repo> <tip-sha> <decisions-file> <file1> [<file2> ...]
#   decisions-conflict-check.sh --selftest
set -u

decisions_conflict_report() {
  local -a files=("$@")
  [ "${#files[@]}" -eq 0 ] && return 0
  local filelist
  filelist="$(mktemp "${TMPDIR:-/tmp}/decisions-conflict-files.XXXXXX")" || return 0
  printf '%s\n' "${files[@]}" >"$filelist"
  awk -v filelist="$filelist" \
      -v max_entries="${DECISIONS_CONFLICT_MAX_ENTRIES:-20}" \
      -v max_lines="${DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY:-12}" '
    BEGIN {
      nf = 0
      while ((getline fline < filelist) > 0) { if (fline != "") farr[++nf] = fline }
      close(filelist)
    }
    { lines[++n] = $0 }
    END {
      nh = 0
      for (i = 1; i <= n; i++) if (lines[i] ~ /^## /) hdr[++nh] = i
      hdr[nh + 1] = n + 1
      printed = 0
      total_matched = 0
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
          total_matched++
          if (printed >= max_entries) continue
          printed++
          print "----"
          print "Erintett fajl(ok): " matched
          print lines[start]
          capturing = 0
          printed_lines = 0
          for (j = start + 1; j <= stop; j++) {
            if (lines[j] ~ /^\*\*(Kontextus|Döntés|Miért|Ki döntött|Hivatkozás):/) {
              if (printed_lines >= max_lines) continue
              print lines[j]; printed_lines++; capturing = 1; continue
            }
            if (capturing) {
              if (lines[j] == "") { capturing = 0; continue }
              if (printed_lines >= max_lines) continue
              print lines[j]; printed_lines++
            }
          }
          if (printed_lines >= max_lines) print "    [...tovabbi sorok elhagyva, DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY=" max_lines "]"
        }
      }
      if (total_matched > printed) print "---- [..." (total_matched - printed) " tovabbi egyezo bejegyzes elhagyva, DECISIONS_CONFLICT_MAX_ENTRIES=" max_entries "]"
    }
  '
  rm -f "$filelist"
  return 0
}

# decisions_conflict_diff_paths -- see the F1a/F1b note above. NUL-delimited `--name-status -M -z`
# parsing (never --name-only): a record is <status>\0<path>\0 normally, or <status>\0<old>\0<new>\0
# for a rename/copy (status starts with R or C) -- read exactly as many NUL fields as the status
# implies, never line-split (a path can itself contain anything except NUL).
decisions_conflict_diff_paths() {
  local repo="$1" base="$2" tip="$3"
  shift 3
  local status path1 path2
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path1 || break
    case "$status" in
      R*|C*)
        IFS= read -r -d '' path2 || break
        printf '%s\n' "$path1" "$path2"
        ;;
      *)
        printf '%s\n' "$path1"
        ;;
    esac
  done < <(git -C "$repo" diff --name-status -M -z "$base" "$tip" -- "$@" 2>/dev/null)
}

# CLI DISPATCH ONLY WHEN EXECUTED, NEVER WHEN SOURCED (same guard as the sibling DECISIONS.md
# scripts -- BASH_SOURCE differs from $0 only when the file is read via `.`/`source`).
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-ref" ]; then
  repo="$2"; tip="$3"; decisions_file="$4"; shift 4
  git -C "$repo" cat-file blob "$tip:$decisions_file" 2>/dev/null | decisions_conflict_report "$@"
  exit 0
fi

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--diff-paths" ]; then
  shift
  decisions_conflict_diff_paths "$@"
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

  # 7. F1c -- a file list long enough to overflow a `-v files_str=...` argv (several MB) must still
  # match, instead of silently producing nothing (the original ARG_MAX failure mode).
  big_files=()
  for i in $(seq 1 20000); do big_files+=("src/padding/file-$i.ts"); done
  big_files+=("src/web/channel-poller-reap.ts")
  out6="$(fixture | decisions_conflict_report "${big_files[@]}")"
  if echo "$out6" | grep -q "első bejegyzés"; then
    ok "a file list too long for a single -v argv still matches (F1c)"
  else
    no "a large file list should still match via the temp-file path: ${out6:0:200}"
  fi

  # 8. F2 -- entry cap: with max_entries=1, two matching entries report only one, plus a trailer
  # naming how many were left out.
  out7="$(fixture | DECISIONS_CONFLICT_MAX_ENTRIES=1 decisions_conflict_report src/web/channel-poller-reap.ts src/db.ts)"
  n_hdr7="$(echo "$out7" | grep -c '^## ')"
  if [ "$n_hdr7" -eq 1 ] && echo "$out7" | grep -q "tovabbi egyezo bejegyzes elhagyva"; then
    ok "DECISIONS_CONFLICT_MAX_ENTRIES caps printed entries and names the leftover count"
  else
    no "expected 1 printed entry + a leftover trailer, got: $out7"
  fi

  # 9. F2 -- per-entry line cap: with max_lines=1, only the first captured field line survives.
  out8="$(fixture | DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY=1 decisions_conflict_report src/web/channel-poller-reap.ts)"
  if echo "$out8" | grep -q "Kontextus:\*\* valami" && ! echo "$out8" | grep -q "két sorban folytatva"; then
    ok "DECISIONS_CONFLICT_MAX_LINES_PER_ENTRY caps continuation lines"
  else
    no "expected only the first field line under the cap, got: $out8"
  fi

  # 10. decisions_conflict_diff_paths -- F1a (non-ASCII, quotepath) + F1b (rename reports BOTH names).
  dp_repo="$(mktemp -d)"
  git -C "$dp_repo" init -q -b main
  git -C "$dp_repo" config user.email t@t
  git -C "$dp_repo" config user.name t
  git -C "$dp_repo" config commit.gpgsign false
  printf 'old\n' >"$dp_repo/árvíztűrő.ts"
  printf 'content\n' >"$dp_repo/old-name.ts"
  git -C "$dp_repo" add .
  git -C "$dp_repo" commit -qm base
  dp_base="$(git -C "$dp_repo" rev-parse HEAD)"
  git -C "$dp_repo" mv old-name.ts new-name.ts
  printf 'édesítve\n' >>"$dp_repo/árvíztűrő.ts"
  git -C "$dp_repo" add .
  git -C "$dp_repo" commit -qm "rename + edit unicode file"
  dp_tip="$(git -C "$dp_repo" rev-parse HEAD)"
  dp_out="$(decisions_conflict_diff_paths "$dp_repo" "$dp_base" "$dp_tip")"
  if echo "$dp_out" | grep -qx "árvíztűrő.ts"; then
    ok "decisions_conflict_diff_paths reports a non-ASCII path literally, unquoted (F1a)"
  else
    no "expected the literal unicode filename, got: $dp_out"
  fi
  if echo "$dp_out" | grep -qx "old-name.ts" && echo "$dp_out" | grep -qx "new-name.ts"; then
    ok "decisions_conflict_diff_paths reports BOTH sides of a rename (F1b)"
  else
    no "expected both old-name.ts and new-name.ts, got: $dp_out"
  fi
  rm -rf "$dp_repo"

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

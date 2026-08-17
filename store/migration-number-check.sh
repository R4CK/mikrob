#!/usr/bin/env bash
# migration-number-check.sh -- catch two branches claiming the SAME migration number
# BEFORE either lands, instead of after.
#
# WHY (Cybersec 2026-08-07, MikroB asked for it): the migration runner already refuses a duplicate
# version at load time (control-plane-migrate.ts, cards 837ba40f + bdfd77f7) -- but only once BOTH
# files sit on the same tree. While they live on separate branches nothing looks wrong: each branch
# is internally consistent, each gate passes, and the collision surfaces as a hard `migrate` failure
# for everyone the moment the second one lands.
#
# It happened: 0082_photo_approvals (card f54d5cdf) and 0082_custody_anchors (card 3448c829) were
# both pending, both gated GO, on different branches. I only noticed because I happened to gate both.
# My first fix suggestion was ALSO wrong -- I said "renumber to 0083", not having looked at the
# subcontractor branches, which had already claimed 0083. Hence this script: the answer needs every
# branch at once, and a human reading one card cannot have it.
#
# CONTRACT:
#   migration-number-check.sh check [<repo>] [<base-ref>]
#       -> "OK: no duplicate migration numbers pending"          exit 0
#       -> "COLLISION: ..." (one line per clash, then a summary)  exit 8
#       -> "SKIP: <reason>"                                       exit 0  (not a repo / no dir)
#   migration-number-check.sh next [<repo>] [<base-ref>]
#       -> prints the next FREE migration number, counting pending branches as taken
#   migration-number-check.sh selftest    -> offline self-test, no repo access, no side effects
#
# Defaults: repo = /mnt/h/LM_Studio_Workdir/CleanCore, base = origin/main.
#
# TWO REFINEMENTS THAT MATTER, both learned from the live case:
#   1. The same file on two branches is ONE claim, not a collision -- the subcontractor slice is
#      pushed on two branches with a byte-identical 0083. Content hash, not branch count, decides.
#   2. LOCAL branches count too. The custody 0082 existed only as a local commit; a remote-only
#      scan would have reported "clean" on the very case that prompted this.
#
# Read-only: git plumbing only, no fetch, no checkout, no writes.
set -euo pipefail

REPO_DEFAULT="/mnt/h/LM_Studio_Workdir/CleanCore"
MIG_DIR="packages/control-plane/migrations"

# Print "<number> <path> <blob-oid> <ref>" for every migration on <ref> that is NOT on base.
#
# PERFORMANCE (this is why it is shaped this way): the obvious version asks git one question PER
# FILE PER REF -- ~80 migrations x ~30 refs is thousands of process spawns, and on the WSL /mnt
# mount that took minutes. Here the base set is read ONCE by the caller, `ls-tree` gives the blob
# OID for free (no `git show` + sha256 needed -- git already content-addresses the file), and only
# the handful of genuinely-pending paths are looked at. One git call per ref.
_pending_on_ref() { # $1 = repo, $2 = ref, $3 = newline-list of base paths
  local repo="$1" ref="$2" basepaths="$3"
  git -C "$repo" ls-tree -r "$ref" -- "$MIG_DIR" 2>/dev/null \
  | awk -v ref="$ref" -v base="$basepaths" '
      BEGIN { n = split(base, b, "\n"); for (i = 1; i <= n; i++) if (b[i] != "") seen[b[i]] = 1 }
      $2 == "blob" {
        oid = $3; path = $4
        for (i = 5; i <= NF; i++) path = path " " $i          # paths with spaces
        if (path !~ /\.sql$/) next
        if (path in seen) next                                 # already on base -> not pending
        f = path; sub(/.*\//, "", f)
        if (match(f, /^[0-9]{3,4}_/) == 0) next
        num = substr(f, 1, RLENGTH - 1) + 0
        printf "%d\t%s\t%s\t%s\n", num, path, substr(oid, 1, 16), ref
      }'
}

_all_refs() { # $1 = repo, $2 = base-ref
  local repo="$1" base="$2"
  {
    git -C "$repo" for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null | grep -v '/HEAD$' || true
    git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null || true
  } | grep -vx "$base" | sort -u
}
# LOCAL-BRANCH POLLUTION IN A SHARED CLONE (card b60e6be2). refs/heads stays in scope on purpose --
# removing it would reopen the exact gap this script exists to close (the custody-0082 collision that
# motivated it lived ONLY as a local commit, see the header). But a shared clone where several agents
# each keep their own feature/landing branches around accumulates STALE local refs from work that has
# already landed (or been abandoned) by a different path -- e.g. `land/durable-batch-*`,
# `landing/batch5b-*` -- and a COLLISION against one of those is not evidence of a real conflict, only
# evidence that nobody deleted the branch. This script does not (and should not try to) guess
# staleness: distinguishing "an abandoned local branch" from "a live one about to be pushed" from git
# history alone is unreliable and a wrong guess would hide a real collision. Before treating a
# COLLISION as real, check EACH claim's ref list in the message: a claim backed only by local refs
# (no origin/* among them) is worth a `git log -1 --format=%cd <ref>`/`git branch -d <ref>` look before
# escalating it, especially if the branch name matches an already-closed card. Periodic pruning of
# merged/abandoned local branches in this shared clone reduces how often this fires on dead weight.

_collect() { # $1 = repo, $2 = base -> the pending table on stdout
  local repo="$1" base="$2" ref basepaths
  # the base migration set, read ONCE (see the note on _pending_on_ref)
  basepaths="$(git -C "$repo" ls-tree -r --name-only "$base" -- "$MIG_DIR" 2>/dev/null || true)"
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    _pending_on_ref "$repo" "$ref" "$basepaths"
  done < <(_all_refs "$repo" "$base")
}

# Decide from the pending table on stdin. Kept separate so the selftest drives the SAME code.
_decide() {
  python3 -c '
import sys, collections
rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line: continue
    parts = line.split("\t")
    if len(parts) != 4: continue
    num, path, h, ref = parts
    rows.append((int(num), path, h, ref))
by_num = collections.defaultdict(dict)          # num -> hash -> (path, [refs])
for num, path, h, ref in rows:
    e = by_num[num].setdefault(h, [path, []])
    e[1].append(ref)
collisions = []
for num in sorted(by_num):
    claims = by_num[num]
    if len(claims) > 1:                          # DIFFERENT content on one number
        # Card b60e6be2: the old message named only the PATH per claim, so two claims that
        # happen to sit at the identical path (the common case -- same filename, different
        # content on two branches) printed as "...path... (on N refs); ...path... (on M refs)",
        # reading like a formatting bug (the same path twice) instead of two distinct versions.
        # The blob hash IS the distinguishing fact, so it goes in the message, and the own ref
        # list of each claim too -- a reader can now tell in one line whether a claim is origin-backed
        # (pushed, real) or local-only (possibly a stale, already-superseded branch in this
        # shared clone -- see the header note on local-branch pollution before treating a
        # local-only claim as a live conflict).
        desc = "; ".join(
            "%s [blob %s] (on: %s)" % (p, h[:16], ", ".join(sorted(r)))
            for h, (p, r) in claims.items()
        )
        collisions.append(f"COLLISION: migration {num:04d} claimed by {len(claims)} different files -- {desc}")
for c in collisions: print(c)
pend = ", ".join(f"{n:04d}" for n in sorted(by_num)) or "(none)"
print(f"pending migration numbers: {pend}")
print(f"SUMMARY: {len(collisions)} collision(s)")
'
}

_next_free() {
  python3 -c '
import sys
nums = set()
for line in sys.stdin:
    p = line.rstrip("\n").split("\t")
    if len(p) == 4: nums.add(int(p[0]))
base = int(sys.argv[1]) if len(sys.argv) > 1 else 0
n = max([base] + sorted(nums)) + 1
print(f"{n:04d}")
' "$1"
}

case "${1:-}" in
  check)
    REPO="${2:-$REPO_DEFAULT}"; BASE="${3:-origin/main}"
    [[ -d "$REPO/.git" ]] || { echo "SKIP: $REPO is not a git repo"; exit 0; }
    git -C "$REPO" rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "SKIP: base ref $BASE not found"; exit 0; }
    # A repo with no migrations directory must SAY SO, not report a clean board. Without this the
    # wrong --repo argument produces "SUMMARY: 0 collision(s)" + exit 0, indistinguishable from a
    # genuinely clean run -- a confident green on a tree the check never looked at. Same principle
    # as a test runner that must fail rather than skip when its fixture is missing.
    if ! git -C "$REPO" cat-file -e "${BASE}:${MIG_DIR}" 2>/dev/null; then
      echo "SKIP: $MIG_DIR does not exist on $BASE in $REPO -- nothing was checked"; exit 0
    fi
    out="$(_collect "$REPO" "$BASE" | _decide)"
    echo "$out"
    grep -q '^COLLISION:' <<< "$out" && exit 8 || exit 0
    ;;

  next)
    REPO="${2:-$REPO_DEFAULT}"; BASE="${3:-origin/main}"
    [[ -d "$REPO/.git" ]] || { echo "SKIP: $REPO is not a git repo"; exit 0; }
    git -C "$REPO" cat-file -e "${BASE}:${MIG_DIR}" 2>/dev/null || {
      echo "SKIP: $MIG_DIR does not exist on $BASE in $REPO -- refusing to invent 0001" >&2; exit 3; }
    highest="$(git -C "$REPO" ls-tree -r --name-only "$BASE" -- "$MIG_DIR" 2>/dev/null \
      | sed -nE 's#.*/([0-9]{3,4})_.*#\1#p' | sort -n | tail -1)"
    _collect "$REPO" "$BASE" | _next_free "$((10#${highest:-0}))"
    ;;

  selftest)
    fail=0
    t() { # $1 = label, $2 = expected substring, stdin = pending table
      local got; got="$(_decide)"
      if grep -qF "$2" <<< "$got"; then echo "  ok   $1"
      else echo "  FAIL $1 -- expected '$2' in:"; sed 's/^/         /' <<< "$got"; fail=1; fi
    }
    echo "migration-number-check selftest"
    t "clean board" "SUMMARY: 0 collision(s)" <<'EOF'
82	packages/control-plane/migrations/0082_a.sql	aaaa	origin/x
83	packages/control-plane/migrations/0083_b.sql	bbbb	origin/y
EOF
    t "two DIFFERENT files on one number" "COLLISION: migration 0082" <<'EOF'
82	packages/control-plane/migrations/0082_photo_approvals.sql	aaaa	origin/x
82	packages/control-plane/migrations/0082_custody_anchors.sql	bbbb	refs/local
EOF
    t "same file on two refs is ONE claim" "SUMMARY: 0 collision(s)" <<'EOF'
83	packages/control-plane/migrations/0083_sub.sql	cccc	origin/a
83	packages/control-plane/migrations/0083_sub.sql	cccc	origin/b
EOF
    t "one claim on two refs + a real clash still collides" "COLLISION: migration 0083" <<'EOF'
83	packages/control-plane/migrations/0083_sub.sql	cccc	origin/a
83	packages/control-plane/migrations/0083_sub.sql	cccc	origin/b
83	packages/control-plane/migrations/0083_other.sql	dddd	origin/c
EOF
    t "empty input is not a collision" "SUMMARY: 0 collision(s)" < /dev/null
    t "pending list is reported" "pending migration numbers: 0082, 0084" <<'EOF'
82	packages/control-plane/migrations/0082_a.sql	aaaa	origin/x
84	packages/control-plane/migrations/0084_b.sql	bbbb	origin/y
EOF
    [[ $fail -eq 0 ]] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
    ;;

  *)
    echo "usage: $0 {check [repo] [base-ref]|next [repo] [base-ref]|selftest}" >&2; exit 2 ;;
esac

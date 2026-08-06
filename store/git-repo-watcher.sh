#!/usr/bin/env bash
# git-repo-watcher.sh -- watch ADOPTED upstream git repos for changes and update.
#
# Peti 2026-07-23: any adopted thing that stays git-updatable must be watched on a
# schedule and updated on change. Safety: third-party EXECUTABLE code is never
# auto-pulled-and-run on a change (a bad/compromised upstream commit would then run
# on the fleet); it is DETECTED + STAGED + FLAGGED for a quick review. Text-only
# adoptions (skills/docs) update immediately -- no supply-chain risk.
#
# Config: store/watched-repos.json -- array of:
#   { "name", "repo" (url), "branch", "local" (checkout path),
#     "type": "text" | "code", "enabled": bool, "last_sha", "note" }
#
# Output (last lines, parsed by the scheduled task):
#   CHANGED:text:<name>:<oldsha>..<newsha>     (auto-updated)
#   CHANGED:code:<name>:<oldsha>..<newsha>     (staged + FLAGGED, not run)
#   NOCHANGE / DISABLED / NOTCLONED / ERROR lines are informational
#   final:  SUMMARY:changed=<n>:flagged=<n>
#
# Ops-scripts rule: tracked + pushed; no secrets embedded.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/watched-repos.json"
[[ -f "$CFG" ]] || { echo "SUMMARY:changed=0:flagged=0 (no config $CFG)"; exit 0; }

changed=0; flagged=0

# read entries as TSV via python (name, repo, branch, local, type, enabled, last_sha)
mapfile -t ROWS < <(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("ERRCFG\t"+str(e)); sys.exit(0)
for r in (d if isinstance(d,list) else []):
    print("\t".join([str(r.get(k,"")) for k in ("name","repo","branch","local","type","enabled","last_sha")]))
' "$CFG")

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name repo branch local type enabled last_sha <<<"$row"
  [[ "$name" == "ERRCFG" ]] && { echo "ERROR:config-parse"; continue; }
  [[ -z "$name" ]] && continue
  branch="${branch:-main}"
  if [[ "$enabled" != "True" && "$enabled" != "true" ]]; then echo "DISABLED:$name ($local)"; continue; fi
  if [[ ! -d "$local/.git" ]]; then echo "NOTCLONED:$name ($local) -- $repo"; continue; fi

  git -C "$local" fetch -q origin "$branch" 2>/dev/null || { echo "ERROR:fetch:$name"; continue; }
  new_sha="$(git -C "$local" rev-parse "origin/$branch" 2>/dev/null)"
  cur_sha="${last_sha:-$(git -C "$local" rev-parse HEAD 2>/dev/null)}"
  if [[ -z "$new_sha" ]]; then echo "ERROR:rev-parse:$name"; continue; fi
  # last_sha in watched-repos.json is often a SHORT (7-8 char) pinned sha, while
  # new_sha from rev-parse is always the full 40-char sha -- an exact `==` never
  # matches a short cur_sha even when nothing changed, flagging a false CHANGED
  # every single run. Prefix-match instead: real divergence still trips this
  # (a colliding prefix on an unrelated new commit is not a realistic risk).
  if [[ "$new_sha" == "$cur_sha"* ]]; then echo "NOCHANGE:$name @ ${new_sha:0:8}"; continue; fi

  if [[ "$type" == "text" ]]; then
    # text-only adoption: safe to fast-forward immediately
    if git -C "$local" merge --ff-only -q "origin/$branch" 2>/dev/null; then
      echo "CHANGED:text:$name:${cur_sha:0:8}..${new_sha:0:8}"
      changed=$((changed+1))
    else
      echo "ERROR:ff-merge:$name (diverged -- manual)"
    fi
  else
    # executable third-party code: DO NOT auto-run a new upstream commit.
    # Leave the working tree on the reviewed sha; the fetch already staged the
    # objects. Flag for a quick supply-chain check before we update+run it.
    echo "CHANGED:code:$name:${cur_sha:0:8}..${new_sha:0:8} FLAGGED-review-before-update"
    flagged=$((flagged+1))
  fi
done

echo "SUMMARY:changed=$changed:flagged=$flagged"

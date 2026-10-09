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
#     "type": "text" | "code", "enabled": bool, "note" }
#
# Card 726dca6b: the reviewed baseline sha used for the NOCHANGE/CHANGED comparison below
# used to live directly in watched-repos.json's "last_sha" field, hand-edited on every manual
# review close-out alongside "note" -- which left the tracked registry permanently dirty on the
# shared main clone and blocked its fast-forward. That moving value now lives in the gitignored
# store/watched-repos-state.json (keyed by name), the SAME file store/external-repos-sync.sh
# already write-backs to and src/web/routes/integrated-repos.ts already merges in. The registry's
# own "last_sha" (if still present on an entry) is read only as a fallback for a name with no
# state entry yet.
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
STATE="${WATCHED_REPOS_STATE_JSON:-$HERE/watched-repos-state.json}"
[[ -f "$CFG" ]] || { echo "SUMMARY:changed=0:flagged=0 (no config $CFG)"; exit 0; }

changed=0; flagged=0

# read entries as TSV via python (name, repo, branch, local, type, enabled, last_sha), merging
# the state file's last_sha over the registry's own (registry value is a fallback only).
#
# Card ed4926a3 (RedHat LOW, ffca678d gate comment 13314): `mapfile` below reads one row per
# OUTPUT LINE -- a tab or newline embedded in any field (most realistically last_sha, which
# comes from the gitignored, less-reviewed state file) splits one logical entry into extra
# bogus rows, and a crafted newline can make the tail of its own value look like a genuine
# "CHANGED:..."/"ERROR:..." line to whoever reads this script's output line-by-line (the
# header above documents exactly that contract). `safe()` strips tab/CR/newline from every
# field before it is ever joined into a row, so this cannot happen regardless of which field
# carries it -- the regex checks further down in the loop are a second layer for last_sha/
# branch specifically, not the only line of defense against output corruption.
mapfile -t ROWS < <(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("ERRCFG\t"+str(e)); sys.exit(0)
try:
    with open(sys.argv[2], encoding="utf-8") as f: state=json.load(f)
except Exception:
    state={}
def safe(s):
    return str(s).replace("\t"," ").replace("\n"," ").replace("\r"," ")
for r in (d if isinstance(d,list) else []):
    raw_name=str(r.get("name",""))
    last_sha=str((state.get(raw_name) or {}).get("last_sha") or r.get("last_sha",""))
    print("\t".join([safe(raw_name), safe(r.get("repo","")), safe(r.get("branch","")), safe(r.get("local","")), safe(r.get("type","")), safe(r.get("enabled","")), safe(last_sha)]))
' "$CFG" "$STATE")

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name repo branch local type enabled last_sha <<<"$row"
  [[ "$name" == "ERRCFG" ]] && { echo "ERROR:config-parse"; continue; }
  [[ -z "$name" ]] && continue
  branch="${branch:-main}"
  if [[ "$enabled" != "True" && "$enabled" != "true" ]]; then echo "DISABLED:$name ($local)"; continue; fi
  if [[ ! -d "$local/.git" ]]; then echo "NOTCLONED:$name ($local) -- $repo"; continue; fi

  # Card ed4926a3 (RedHat INFO, ffca678d gate comment 13314): branch comes from the TRACKED
  # registry (lower risk than the gitignored state-file last_sha was, but still unvalidated)
  # and feeds two git argv positions below. The fetch call is the real injection point: an
  # option-shaped branch (e.g. "--upload-pack=...") is a bare positional refspec there, with
  # nothing before it in the string to stop git parsing it as a flag (measured above in the
  # review: `git fetch origin -- "--upload-pack=..."` is rejected as an invalid refspec once
  # end-of-options is in front of it; without it, option parsing applies). Fail-closed: reject
  # anything outside a conservative ref-name allowlist before it reaches git at all.
  if [[ ! "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] || [[ "$branch" == *..* ]]; then
    safe_branch="$(printf '%s' "$branch" | tr -cd '[:print:]' | cut -c1-80)"
    echo "ERROR:badbranch:$name (branch '$safe_branch' is not a valid ref name, skipping)"
    continue
  fi

  # --end-of-options is a second layer in front of the fetch refspec (confirmed safe: git
  # fetch consumes it and still resolves a normal branch correctly). It is deliberately NOT
  # added to the rev-parse call below -- git rev-parse echoes --end-of-options/-- back as a
  # literal output line instead of consuming it, which would corrupt the single-line $(...)
  # capture on the next line. The allowlist above is rev-parse's actual defense.
  git -C "$local" fetch -q origin --end-of-options "$branch" 2>/dev/null || { echo "ERROR:fetch:$name"; continue; }
  new_sha="$(git -C "$local" rev-parse "origin/$branch" 2>/dev/null)"
  # Card ffca678d (RedHat LOW): last_sha comes from the state file (or, as fallback, the
  # tracked registry) and feeds a bash glob prefix-match below. An unvalidated value here
  # (too short, or not hex at all) can make "$new_sha" == "$cur_sha"* match spuriously,
  # silently turning a real CHANGED/FLAGGED into NOCHANGE. Fail-closed: reject anything that
  # is not 7-40 lowercase hex chars and fall back to the checkout's own (trusted) HEAD.
  if [[ -n "$last_sha" && ! "$last_sha" =~ ^[0-9a-f]{7,40}$ ]]; then
    # Card ed4926a3 (RedHat LOW, ffca678d gate comment 13314): the raw value used to be quoted
    # straight into this line. A newline in it could forge an extra output line (this script's
    # own header says its output is parsed line-by-line by the scheduled task); printable-ASCII
    # only + a length cap neutralises that and any terminal-escape payload too.
    safe_sha="$(printf '%s' "$last_sha" | tr -cd '[:print:]' | cut -c1-80)"
    echo "ERROR:badsha:$name (last_sha '$safe_sha' is not a valid hex sha, ignoring recorded value)"
    last_sha=""
  fi
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

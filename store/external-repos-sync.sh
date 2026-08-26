#!/bin/bash
# Marveen external-repo sync: pulls vendored third-party repos and re-links
# their safe (markdown) skills into ~/.claude/skills/. Executable hooks are
# NEVER auto-enabled. Idempotent; safe to run daily.
#
# LIVE PATH: symlinked from ~/.claude/external/sync.sh (card 9b9422d1). The script used to live
# ONLY there, outside any git repo -- a running operational script the fleet's own rule
# (ops-scripts-version-controlled) says must never happen. Tracked here now; the live path is a
# symlink so the scheduled task's existing `bash ~/.claude/external/sync.sh` invocation is
# untouched.
set -u
EXT="${EXTERNAL_REPOS_DIR:-$HOME/.claude/external}"
# Same env var scripts/skill-index.sh already respects (step 3 below invokes it as a subprocess,
# which inherits this from the environment -- no separate override needed for that call).
SKILLS="${SKILL_INDEX_GLOBAL_DIR:-$HOME/.claude/skills}"
WATCHED_JSON="${WATCHED_REPOS_JSON:-/home/neon/marveen/store/watched-repos.json}"
CHANGED=0

# Card 307abedd: writes the ACTUAL new HEAD + today's date into WATCHED_JSON's entry for repo $1,
# leaving every other field (including every other repo's entry) untouched. Matches by the JSON
# "name" field, which is exactly the loop variable below for the 11 daily-synced repos -- no path
# translation needed, and it is robust to `local` being a symlink or differently formatted.
# Silently no-ops if WATCHED_JSON has no entry for $1 (e.g. a repo not yet registered there) --
# this script's job is to sync clones, not to own the registry's shape.
write_back() {
  local name="$1" sha="$2"
  python3 - "$WATCHED_JSON" "$name" "$sha" <<'PY'
import json
import sys
from datetime import date

path, name, sha = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    sys.exit(0)

changed = False
for entry in data:
    if entry.get("name") == name:
        entry["last_sha"] = sha
        entry["last_checked_at"] = date.today().isoformat()
        changed = True
        break

if changed:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
PY
}

pull() {
  local d="$EXT/$1"
  [ -d "$d/.git" ] || { echo "skip (not cloned): $1"; return; }
  local before after
  before=$(git -C "$d" rev-parse HEAD 2>/dev/null)
  # Captured BEFORE fetch touches origin/main: what we last knew upstream to be. This is the
  # load-bearing value for the safety check below -- NOT the upstream we are about to fetch.
  local old_upstream
  old_upstream=$(git -C "$d" rev-parse '@{u}' 2>/dev/null)
  if git -C "$d" pull --ff-only --quiet 2>/dev/null; then
    after=$(git -C "$d" rev-parse HEAD 2>/dev/null)
    if [ "$before" != "$after" ]; then echo "updated: $1 ($before -> $after)"; CHANGED=1; else echo "current: $1"; fi
    write_back "$1" "$after"
    return
  fi
  # --ff-only REFUSED (card 9b9422d1). Was reported as "current" here, unconditionally, because
  # the pull's stderr went to /dev/null and nothing checked its exit status -- a rebased/force-
  # pushed upstream (the common cause on a reference repo whose maintainer squashes history) left
  # the vendored copy stuck forever while the daily log kept saying everything was fine. Measured:
  # awesome-agent-skills 422 commits behind, loki-mode 170, both silently "current" every day.
  #
  # Recovery only when it is PROVABLY safe. The tempting check is "does the NEW upstream (after
  # fetch) contain everything HEAD has" -- but a genuine upstream rebase/amend, by construction,
  # rewrites history: HEAD's old commit is NEVER reachable from the new rewritten tip, with or
  # without any local edit. That check would refuse EVERY real rebase, including the untouched
  # common case, defeating the fix (measured while building this: it did exactly that on a clean
  # simulated rebase with zero local commits).
  # The correct question is "did HEAD move away from what upstream was LAST TIME we looked" --
  # these repos are vendored REFERENCES, never edited in place, so if HEAD still equals the OLD
  # upstream position, nothing local happened between syncs and 100% of the divergence is
  # upstream's own history rewrite, safe to follow. If HEAD has moved on from there, something
  # (a local commit) happened, and a human decides, not a silent reset.
  git -C "$d" fetch --quiet 2>/dev/null
  local new_upstream
  new_upstream=$(git -C "$d" rev-parse '@{u}' 2>/dev/null) || {
    echo "DIVERGED (no upstream tracking branch, needs a manual look): $1"
    return
  }
  if [ -z "$old_upstream" ] || [ "$before" != "$old_upstream" ]; then
    echo "DIVERGED (HEAD is not where the last known upstream position was, refusing to reset -- needs a manual look): $1"
    return
  fi
  git -C "$d" reset --hard "$new_upstream" >/dev/null 2>&1
  after=$(git -C "$d" rev-parse HEAD 2>/dev/null)
  if [ "$before" != "$after" ]; then echo "updated (non-ff, reset to $new_upstream): $1 ($before -> $after)"; CHANGED=1
  else echo "current: $1"; fi
  # $after is the ACTUAL post-reset HEAD (verified via rev-parse), not $new_upstream -- reset --hard
  # can itself fail silently under `set -u` without -e, so this must read the real result, never the
  # intended target.
  write_back "$1" "$after"
}

# 1) Pull the repos that exist. (2026-07-31 Peti adopt-9: +6 doc/skill/index repos, cloned
#    OUTSIDE the tracked marveen repo so the Szotasz/marveen ff-only update stays intact.)
for r in awesome-claude-skills claude-agent-sdk superpowers Skill_Seekers loki-mode \
         anthropics-skills claude-code-best-practice awesome-claude-code-jqueryscript \
         awesome-agent-skills claude-skills-alirezarezvani claude-code-ultimate-guide; do pull "$r"; done

# 2) Re-link superpowers skills (markdown only) as sp-<name>. Symlinks reflect
#    upstream updates automatically. Drop stale sp-* links first.
find "$SKILLS" -maxdepth 1 -type l -name 'sp-*' -delete 2>/dev/null
if [ -d "$EXT/superpowers/skills" ]; then
  for s in "$EXT/superpowers/skills"/*/; do
    [ -f "$s/SKILL.md" ] || continue
    n=$(basename "$s")
    ln -sfn "$s" "$SKILLS/sp-$n"
  done
  echo "linked superpowers skills: $(find "$EXT/superpowers/skills" -name SKILL.md | wc -l)"
fi

# 3) Regen the skill index so the new skills are discoverable.
bash /home/neon/marveen/scripts/skill-index.sh >/dev/null 2>&1 && echo "skill index regenerated"

echo "CHANGED=$CHANGED"

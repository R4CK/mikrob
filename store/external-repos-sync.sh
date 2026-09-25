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
# Card 197947ae: WATCHED_JSON is the tracked, hand-maintained registry -- write_back() used to
# mutate it directly on every daily run, leaving the SHARED main clone's working tree dirty with a
# routine last_sha/last_checked_at bump (never committed, blocking marveen-land.sh's fast-forward
# and the next update.sh pull --ff-only). The post-pull sha/date now goes into this separate,
# gitignored state file instead (store/* is ignored by default, no !unignore added for it) --
# routine sync churn stops touching tracked content; a licence-relevant registry edit still only
# happens by hand, through the existing reviewed git-repo-watcher.sh close-out step.
WATCHED_STATE_JSON="${WATCHED_REPOS_STATE_JSON:-/home/neon/marveen/store/watched-repos-state.json}"
CHANGED=0

# Writes the ACTUAL new HEAD + today's date for repo $1 into WATCHED_STATE_JSON, keyed by name,
# leaving every other repo's state entry untouched. Only writes when $1 has a registry entry in
# WATCHED_JSON (read-only check) -- this script's job is to sync clones, not to own the registry's
# shape, and a name with no registry entry should not grow a phantom state row either.
write_back() {
  local name="$1" sha="$2"
  python3 - "$WATCHED_JSON" "$WATCHED_STATE_JSON" "$name" "$sha" <<'PY'
import json
import sys
from datetime import date

registry_path, state_path, name, sha = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    with open(registry_path, encoding="utf-8") as f:
        registry = json.load(f)
except FileNotFoundError:
    sys.exit(0)

if not any(entry.get("name") == name for entry in registry):
    sys.exit(0)

try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {}

state[name] = {"last_sha": sha, "last_checked_at": date.today().isoformat()}

with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
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
         awesome-agent-skills claude-skills-alirezarezvani claude-code-ultimate-guide \
         awesome-claude-code; do pull "$r"; done

# 2) Re-link superpowers skills (markdown only) as sp-<name>. Symlinks reflect
#    upstream updates automatically. Drop stale sp-* links first.
find "$SKILLS" -maxdepth 1 -type l -name 'sp-*' -delete 2>/dev/null
if [ -d "$EXT/superpowers/skills" ]; then
  kept_real=0
  for s in "$EXT/superpowers/skills"/*/; do
    [ -f "$s/SKILL.md" ] || continue
    n=$(basename "$s")
    dest="$SKILLS/sp-$n"
    # Card 7d2ebd24: these entries are REAL DIRECTORIES now, not links. Two reasons this must skip
    # them rather than relink:
    #
    #   1. `ln -sfn <target> <real dir>` does not replace the directory -- it drops a stray symlink
    #      INSIDE it (measured: sp-brainstorming/brainstorming), and `ln` reports success. Running
    #      this unchanged would have quietly polluted all 14.
    #   2. A real directory is the FORK's own copy. Three of them carry fork-written content that
    #      does not exist upstream (70 lines, card 4a3c75a5). Relinking would put the read path back
    #      behind the vendored checkout, which is exactly what 7d2ebd24 removed.
    #
    # Taking a vendor update into one of these is a deliberate merge into seed-skills/, never an
    # automatic copy -- see docs/fork-additions-to-vendored-skills.md.
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      kept_real=$((kept_real + 1))
      continue
    fi
    ln -sfn "$s" "$dest"
  done
  echo "linked superpowers skills: $(find "$EXT/superpowers/skills" -name SKILL.md | wc -l) (kept $kept_real fork-owned real dir(s) untouched)"
fi

# 3) Regen the skill index so the new skills are discoverable.
bash /home/neon/marveen/scripts/skill-index.sh >/dev/null 2>&1 && echo "skill index regenerated"

echo "CHANGED=$CHANGED"

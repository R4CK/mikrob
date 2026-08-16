#!/usr/bin/env bash
# seed-skills-untracked-check.sh -- runtime guard for card f39dd8fb.
#
# WHY: install-macos.sh/install-linux.sh used to `cp -r` seed-skills/<skill>/ from DISK into every
# new install's ~/.claude/skills/, which means anything physically sitting in that directory
# shipped verbatim -- untracked scratch files, gitignored build debris, whatever. The concrete find
# was seed-skills/ui-ux-pro-max/scripts/__pycache__/*.pyc, gitignored, with another machine's HOME
# path baked into it: not a secret, but exactly the shape HOME_PATH_RX forbids in shipped
# templates, and the repo guards never saw it. `git archive`-based install (this card's other half)
# fixes the SHIP side; this is the DETECTION side, and it has to be structurally different: the
# repo guards (token-in-argv-guard.test.ts etc.) run via fleet-test.sh against a checked-out git
# ref, which by construction never HAS an untracked file. This script inspects the LIVE checkout
# instead, so it must run from doctor.sh or a scheduled ops check, never from fleet-test.sh.
#
# OUTPUT (stdout): one path per untracked/ignored file found under seed-skills/, or "CLEAN".
# Exit: 0 clean | 1 found untracked/ignored file(s) | 2 error (not a git repo).
set -uo pipefail

REPO="${MARVEEN_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"

git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR:not-a-git-repo:$REPO"
  exit 2
}

# --ignored=matching seed-skills/ reports BOTH plain-untracked (`??`) and gitignored (`!!`) paths
# in one pass. The old `cp -r` shipped both classes identically -- .gitignore never protected
# against this class of leak, it only hid the file from `git status` by default -- so the guard
# must catch both, not only the ones a plain `git status` already shows.
found=$(git -C "$REPO" status --porcelain --ignored=matching -- seed-skills/ \
  | awk '/^(\?\?|!!) /{print substr($0, 4)}')

if [ -z "$found" ]; then
  echo "CLEAN"
  exit 0
fi

echo "UNTRACKED file(s) under seed-skills/ would ship verbatim on the next install (card f39dd8fb):"
echo "$found" | sed 's/^/  /'
echo "Fix: \`git add\` it if it belongs in the repo, or delete it if it is scratch/build debris."
exit 1

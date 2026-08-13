#!/usr/bin/env bash
# vendor-skill.sh -- vendor an ADOPTED upstream skill into ~/.claude/skills/<name>/ (card f64fe6e1).
#
# WHY A SCRIPT AND NOT A ONE-OFF COPY: a vendored skill has to be re-pullable and auditable. Every
# vendored dir carries a VENDORED.md recording WHERE it came from, WHICH commit was pulled, and under
# WHICH licence -- so a later reader can tell adopted code from ours, and a re-vendor is one command.
#
# SAFETY / UPDATE-SAFETY:
#   * The upstream CLONE lives in store/adopted/<repo> -- store/ is gitignored, so the Marveen repo
#     never gains a tracked file from an adoption and update.sh's ff-only pull can never conflict
#     (the epic's explicit guarantee: "minden vendorolva a repon KIVUL").
#   * The vendored COPY lives in ~/.claude/skills/<name>/ -- outside the repo entirely.
#   * This script FETCHES and copies at an EXPLICIT commit. It never auto-follows upstream: pulling a
#     new upstream commit is a deliberate re-run, which is the "detect+flag, nem vak update" rule.
#   * A skill is INSTRUCTIONS THAT STEER AGENTS. That is a supply-chain surface even though it is
#     "just text", which is why the registry entries are type=code (watcher flags, never auto-ffs).
#
# Usage:
#   vendor-skill.sh --repo <url> --name <vendored-name> [--subdir <path/in/repo>] [--ref <branch|sha>]
#                   [--note "restriction or usage note"]
#
# Exit: 0 ok | 2 bad usage | 3 clone/fetch failed | 4 subdir missing
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADOPTED_DIR="$HERE/adopted"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

REPO=""; NAME=""; SUBDIR=""; REF=""; NOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO="$2"; shift 2 ;;
    --name)   NAME="$2"; shift 2 ;;
    --subdir) SUBDIR="$2"; shift 2 ;;
    --ref)    REF="$2"; shift 2 ;;
    --note)   NOTE="$2"; shift 2 ;;
    *) echo "vendor-skill: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" && -n "$NAME" ]] || { echo "usage: vendor-skill.sh --repo <url> --name <name> [--subdir p] [--ref r] [--note n]" >&2; exit 2; }

# Clone dir key = OWNER__REPO, never just the basename: two adopted repos can share a name
# (mattpocock/skills and crafter-station/skills both basename to "skills"), and a bare-basename key
# made them collide into ONE clone -- which silently vendored the WRONG repo's contents. Caught in
# testing; keep the owner in the key.
_norepo="${REPO%.git}"
_owner="$(basename "$(dirname "$_norepo")")"
slug="${_owner}__$(basename "$_norepo")"
clone="$ADOPTED_DIR/$slug"
mkdir -p "$ADOPTED_DIR"

if [[ -d "$clone/.git" ]]; then
  git -C "$clone" fetch -q --all --tags || { echo "vendor-skill: fetch failed for $REPO" >&2; exit 3; }
else
  git clone -q "$REPO" "$clone" || { echo "vendor-skill: clone failed for $REPO" >&2; exit 3; }
fi

# Resolve the ref we are vendoring FROM (explicit ref, else the remote default head).
if [[ -n "$REF" ]]; then
  git -C "$clone" checkout -q "$REF" 2>/dev/null || { echo "vendor-skill: no such ref '$REF'" >&2; exit 3; }
else
  def="$(git -C "$clone" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
  git -C "$clone" checkout -q "${def#origin/}" 2>/dev/null || true
  git -C "$clone" merge -q --ff-only "$def" 2>/dev/null || true
fi

SHA="$(git -C "$clone" rev-parse HEAD)"
SHA_DATE="$(git -C "$clone" log -1 --format=%cI HEAD)"

src="$clone"
[[ -n "$SUBDIR" ]] && src="$clone/$SUBDIR"
[[ -d "$src" ]] || { echo "vendor-skill: subdir '$SUBDIR' not in $REPO@$SHA" >&2; exit 4; }

# Licence text, if the upstream ships one (copied verbatim alongside the vendored files).
# SUBDIR FIRST, repo root second: a skill monorepo can licence each skill separately and ship NO root
# LICENSE at all (anthropics/skills -- Apache-2.0 per skill dir, proprietary for the document skills).
# Root-only lookup made VENDORED.md claim "upstream ships no LICENSE file" while the real licence sat
# in the vendored subdir -- a provenance record that lies about the licence is worse than none.
LICENSE_FILE=""
for d in ${SUBDIR:+"$src"} "$clone"; do
  for c in LICENSE LICENSE.md LICENSE.txt COPYING; do
    [[ -f "$d/$c" ]] && { LICENSE_FILE="$d/$c"; break 2; }
  done
done

dest="$SKILLS_DIR/$NAME"
mkdir -p "$dest"
# Replace the vendored payload but KEEP our own VENDORED.md/UPSTREAM-LICENSE (rewritten below).
find "$dest" -mindepth 1 -maxdepth 1 ! -name 'VENDORED.md' ! -name 'UPSTREAM-LICENSE' -exec rm -rf {} + 2>/dev/null
cp -R "$src/." "$dest/" 2>/dev/null || { echo "vendor-skill: copy failed" >&2; exit 4; }
[[ -n "$LICENSE_FILE" ]] && cp "$LICENSE_FILE" "$dest/UPSTREAM-LICENSE"

# The two ${VAR:+...}${VAR:-...} halves cannot share one variable: when LICENSE_FILE is SET the
# second half expands to its VALUE, not to the fallback, so the row rendered as
# "see UPSTREAM-LICENSE next to this file/abs/path/LICENSE". Resolve the row up front instead.
if [[ -n "$LICENSE_FILE" ]]; then
  LICENSE_ROW="see UPSTREAM-LICENSE next to this file (upstream: \`${LICENSE_FILE#"$clone"/}\`)"
else
  LICENSE_ROW="(upstream ships no LICENSE file -- verify before use)"
fi

cat > "$dest/VENDORED.md" <<EOF
# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | $REPO |
| subdir | ${SUBDIR:-<repo root>} |
| vendored commit | \`$SHA\` |
| commit date | $SHA_DATE |
| vendored at | $(date -Iseconds) |
| licence | $LICENSE_ROW |
| watch clone | $clone |

${NOTE:+> **Usage restriction:** $NOTE}

## Re-vendor

\`\`\`
store/vendor-skill.sh --repo $REPO --name $NAME${SUBDIR:+ --subdir $SUBDIR}
\`\`\`

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
EOF

echo "VENDORED:$NAME:${SHA:0:8}:$dest"

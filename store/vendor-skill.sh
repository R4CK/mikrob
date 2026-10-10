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
#   * The vendored COPY lives in ~/.claude/skills/<name>/ -- outside the repo entirely. With
#     --dest <dir> it goes to <dir>/<name>/ instead (card da47b612): a skill meant for ONE agent
#     (e.g. seed-fleet-agents/cybersec/.claude/skills) must not land in the global dir, because every
#     skill there is offered to EVERY agent's session context.
#   * This script FETCHES and copies at an EXPLICIT commit. It never auto-follows upstream: pulling a
#     new upstream commit is a deliberate re-run, which is the "detect+flag, nem vak update" rule.
#   * A skill is INSTRUCTIONS THAT STEER AGENTS. That is a supply-chain surface even though it is
#     "just text", which is why the registry entries are type=code (watcher flags, never auto-ffs).
#
# Usage:
#   vendor-skill.sh --repo <url> --name <vendored-name> [--subdir <path/in/repo>] [--ref <branch|sha>]
#                   [--note "restriction or usage note"] [--dest <skills-dir>]
#
# Destination precedence: --dest, then $CLAUDE_SKILLS_DIR, then ~/.claude/skills (the default is
# unchanged, so every existing caller keeps vendoring to the global dir).
#
# Exit: 0 ok | 2 bad usage | 3 clone/fetch failed | 4 subdir missing | 5 sanctioned-exclusion check failed
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADOPTED_DIR="$HERE/adopted"

REPO=""; NAME=""; SUBDIR=""; REF=""; NOTE=""; DEST_DIR=""; DEST_SET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO="$2"; shift 2 ;;
    --name)   NAME="$2"; shift 2 ;;
    --subdir) SUBDIR="$2"; shift 2 ;;
    --ref)    REF="$2"; shift 2 ;;
    --note)   NOTE="$2"; shift 2 ;;
    --dest)   DEST_DIR="${2:-}"; DEST_SET=1; shift; [[ $# -gt 0 ]] && shift ;;
    *) echo "vendor-skill: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" && -n "$NAME" ]] || { echo "usage: vendor-skill.sh --repo <url> --name <name> [--subdir p] [--ref r] [--note n] [--dest d]" >&2; exit 2; }
# An explicit but EMPTY --dest must not fall through to the global default: the caller asked for a
# specific place, and silently vendoring into ~/.claude/skills is exactly the outcome --dest exists
# to prevent.
if [[ "$DEST_SET" == 1 && -z "$DEST_DIR" ]]; then
  echo "vendor-skill: --dest needs a directory" >&2; exit 2
fi
SKILLS_DIR="${DEST_DIR:-${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}}"

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
# SYMLINKESC924 (card f3a6f30a, RedHat follow-up on fd0b2180): plain `cp -R` preserves symlinks
# as symlinks. An upstream symlink (e.g. a vendored dir someone symlinked to a shared asset, or
# a planted one) then lands INSIDE $dest as a live symlink that can point anywhere on disk --
# every later operation that walks into it (the sanctioned-exclusion rm -rf below, or a reader
# of the vendored skill) escapes $dest through it. `-L` dereferences every symlink at copy time,
# so $dest only ever contains the symlink's TARGET content, never the symlink itself; the two
# escape vectors this closes are: (1) a sanctioned "missing:<path>" naming a path through such a
# symlinked directory, and (2) upstream shipping a file named VENDORED.md/UPSTREAM-LICENSE that
# is itself a symlink, which this script's own writes further below would otherwise follow.
cp -RL "$src/." "$dest/" 2>/dev/null || { echo "vendor-skill: copy failed" >&2; exit 4; }
# Card 728179d1 (Cybersec, card 3c73a420): a root-vendored skill (no --subdir) has src == $clone,
# so `cp -R "$src/."` copies $clone/.git along with the payload -- the vendored copy becomes a full
# git working tree tracking upstream, which a bare `git pull`/`git restore`/`git checkout .` can
# then act on with no review, no card, no signal (measured live on ~/.claude/skills/caveman and
# ~/.claude/skills/unlazy). A --subdir vendor never hits this (its src is a subdirectory that does
# not contain .git), but the removal below is unconditional rather than gated on SUBDIR being unset
# -- a vendored skill directory must never be a git working tree, in either mode, so there is no
# case where keeping .git would be correct.
rm -rf "$dest/.git"

# EXCLUSION924 (card fd0b2180, Cybersec F1 on 728179d1): a re-vendor copies whatever upstream
# ships TODAY, with no memory of a deliberate exclusion decision (e.g. Peti removing a paid
# feature's files after the first vendor). store/vendored-skill-sanctioned.json's "missing:<path>"
# entries ARE that memory -- re-apply them here, after the copy, so a path Peti excluded stays
# excluded across every re-vendor, not just the one where it was removed by hand. Key format must
# match vendored-skill-integrity.py's own: $HOME prefix replaced by literal `~`.
SANCTIONED_FILE="${VENDOR_SANCTIONED_FILE:-$HERE/vendored-skill-sanctioned.json}"
if [[ -f "$SANCTIONED_FILE" ]]; then
  dest_key="${dest/#"$HOME"/\~}"
  # FAILCLOSED924 (card f3a6f30a): a corrupt/unreadable sanctioned.json used to make this whole
  # block silently apply ZERO exclusions (python swallowed the error with sys.exit(0), bash read
  # zero lines from the empty pipe) -- a previously-sanctioned-missing path then quietly
  # reappears with exit 0, and nothing notices until the next integrity-heartbeat run, hours
  # later. A corrupt baseline must fail the vendor now, not go unnoticed until then.
  sanctioned_excl="$(python3 -c "
import json, sys
with open(sys.argv[1], encoding='utf-8') as fh:
    data = json.load(fh)
for k in data.get('sanctioned', {}).get(sys.argv[2], []):
    if k.startswith('missing:'):
        print(k[len('missing:'):])
" "$SANCTIONED_FILE" "$dest_key")"
  if [[ $? -ne 0 ]]; then
    echo "vendor-skill: sanctioned-exclusions file unreadable/corrupt ($SANCTIONED_FILE) -- refusing to vendor without the exclusion guarantee" >&2
    exit 5
  fi
  dest_real="$(realpath -m -- "$dest")"
  while IFS= read -r excl; do
    [[ -n "$excl" ]] || continue
    # A malformed/malicious sanctioned.json entry must not escape $dest via an absolute path or
    # a `..` segment -- this is a trusted, repo-controlled file today, but the blast radius of a
    # typo (rm -rf outside $dest) is large enough that the check is cheap insurance regardless.
    # A rejected entry now aborts the vendor (nonzero exit) instead of silently skipping it: a
    # silent skip degrades a deliberate exclusion decision back to "not excluded" with no signal.
    case "$excl" in
      /*|*..*) echo "vendor-skill: refusing suspicious sanctioned exclusion path '$excl'" >&2; exit 5 ;;
    esac
    # REALPATH924 (card f3a6f30a): the lexical ".." check above catches a bad ENTRY, but says
    # nothing about a symlink COMPONENT already inside $dest resolving the same entry outside
    # it. Resolve the real, symlink-free path and require it to stay under $dest before deleting
    # anything through it -- this is defense in depth alongside the -L copy fix above, for any
    # symlink that ends up in $dest some other way (a pre-existing dir from before this fix, or
    # a future copy path that does not go through the -L step).
    target="$dest/$excl"
    if [[ -e "$target" || -L "$target" ]]; then
      target_real="$(realpath -m -- "$target")"
      case "$target_real" in
        "$dest_real"/*) ;;
        *) echo "vendor-skill: sanctioned exclusion '$excl' resolves outside dest ($target_real), refusing" >&2; exit 5 ;;
      esac
    fi
    rm -rf -- "${dest:?}/${excl:?}"
  done <<< "$sanctioned_excl"
fi

# WRITETHRU924 (card f3a6f30a): upstream shipping a file literally named UPSTREAM-LICENSE (or
# VENDORED.md, below) that is a symlink would otherwise have this write FOLLOW it and overwrite
# whatever it points to -- `cp`'s default is to follow an existing destination symlink, same as
# the shell's own `>` redirection. The -L copy above already dereferences such a symlink into a
# plain file, so this is defense in depth: unlink first if, for any other reason, it is still a
# symlink, so the write always lands on a fresh regular file under $dest.
[[ -L "$dest/UPSTREAM-LICENSE" ]] && rm -f "$dest/UPSTREAM-LICENSE"
[[ -n "$LICENSE_FILE" ]] && cp "$LICENSE_FILE" "$dest/UPSTREAM-LICENSE"

# The two ${VAR:+...}${VAR:-...} halves cannot share one variable: when LICENSE_FILE is SET the
# second half expands to its VALUE, not to the fallback, so the row rendered as
# "see UPSTREAM-LICENSE next to this file/abs/path/LICENSE". Resolve the row up front instead.
if [[ -n "$LICENSE_FILE" ]]; then
  LICENSE_ROW="see UPSTREAM-LICENSE next to this file (upstream: \`${LICENSE_FILE#"$clone"/}\`)"
else
  LICENSE_ROW="(upstream ships no LICENSE file -- verify before use)"
fi

# See WRITETHRU924 above: the shell's `>` redirection follows an existing destination symlink
# exactly like `cp` does.
[[ -L "$dest/VENDORED.md" ]] && rm -f "$dest/VENDORED.md"
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
store/vendor-skill.sh --repo $REPO --name $NAME${SUBDIR:+ --subdir $SUBDIR}${REF:+ --ref $REF}${NOTE:+ --note \"$NOTE\"}${DEST_DIR:+ --dest $DEST_DIR}
\`\`\`

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
EOF

echo "VENDORED:$NAME:${SHA:0:8}:$dest"

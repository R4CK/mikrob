#!/usr/bin/env bash
# repomix.sh -- the fleet's ONLY entry point to repomix (card b41c3dd3, Cybersec conditional GO cm#6194).
#
# WHY A WRAPPER: repomix packs an ENTIRE repo into one AI-ready file. That is exactly the shape of an
# accidental secret-exfiltration path, and Cybersec's load-bearing conditions are behavioural, not
# install-time -- they have to be enforced at the CALL, which is what this script does:
#   * condition 4 -- the secretlint security check must NEVER be disabled. `--no-security-check` (and
#     any enableSecurityCheck:false spelling) is REFUSED here. Upstream defaults it ON; this makes it
#     non-negotiable for the fleet so one flag cannot turn a convenience tool into a bulk secret
#     collector.
#   * condition 5 -- output is treated as SENSITIVE: it goes to a gitignored path by default and is
#     never written into the tracked tree.
#   * condition 6 -- `--remote` (fetch an arbitrary repo) is REFUSED; fetching third-party code is an
#     adopt decision, not a flag.
#   * condition 3 -- the binary is the pinned REGISTRY install (~/.npm-tools, --ignore-scripts), NOT on
#     PATH, so this wrapper is the discoverable way in (graphify lesson: a raw CLI on PATH is a bypass).
#
# USAGE:
#   store/repomix.sh pack <repo-path> [-- <extra repomix args>]   # -> gitignored output file
#   store/repomix.sh doctor                                       # version + pin check
#
# HONEST LIMIT: same-user callers can still execute the pinned binary directly; this is not an
# OS boundary. It closes every default and documented path, which is what a fleet convention can do.
#
# HONEST LIMIT 2 -- what condition 4 does NOT cover (measured by Cybersec 2026-08-07, do not delete):
#   * The scan can be muted FROM CONTENT. secretlint honours in-file `secretlint-disable` markers, so
#     a file could silence the scan of its own secret while the pack still reported "No suspicious
#     files detected". `pack` now REFUSES a tree containing such a marker, which closes that path --
#     but the mechanism is a content convention, not a guarantee, so treat a clean scan as evidence
#     about DEFAULTS, never as proof the tree is secret-free.
#   * AWS coverage is KEYWORD-ANCHORED, and worse than first written (re-measured, card 2f781b49):
#     an access key ID is NOT detected in ANY form -- not bare, and not even named
#     (`aws_access_key_id = <key>`); the preset's AWS anchor only ever fires on the SECRET key. And
#     that secret rule ends in `\b` while its own 40-char class contains `/`, `+`, `=`, so a secret
#     whose LAST character is one of those silently passes (~3% of AWS-generated secrets; measured
#     with five files differing only in the final character). Both are properties of the secretlint
#     preset, not of any repomix version -- pinning back would not help.
#     NOW MITIGATED, not eliminated: `pack` runs store/secret-shape-scan.py first, a shape-based
#     pre-filter that catches both cases. It does not make the preset better; it means the preset is
#     no longer the only thing between a credential and the pack.
# A control we wrongly believe is closed is worse than one with a known gap; that is why both are
# written here rather than in a card comment.
#
# Exit: 0 ok | 2 bad usage | 4 setup/usage failure | 5 secretlint-disable marker in the tree
#       | 6 forbidden flag (--no-security-check / --remote) | 7 shape-scan refusal
set -euo pipefail

PINNED_VERSION="1.18.0"
REPOMIX_BIN="${REPOMIX_BIN:-$HOME/.npm-tools/bin/repomix}"
OUT_DIR_DEFAULT="/home/neon/marveen/store/repomix-out"

die() { echo "repomix.sh: $2" >&2; exit "$1"; }
[[ -x "$REPOMIX_BIN" ]] || die 4 "repomix not found at $REPOMIX_BIN (npm install --prefix ~/.npm-tools --ignore-scripts repomix@$PINNED_VERSION)"

# --- condition 4 + 6: refuse the forbidden flags anywhere in argv -------------------------------
for a in "$@"; do
  case "$a" in
    --no-security-check|--no-security|--security-check=false)
      die 6 "REFUSED: '$a' disables the secretlint scan. Cybersec condition 4 (cm#6194) forbids it fleet-wide -- repomix would become a bulk secret collector." ;;
    --remote|--remote=*)
      die 6 "REFUSED: '$a' fetches a third-party repo. Cybersec condition 6 (cm#6194): that is an adopt review, not a flag." ;;
  esac
done

CMD="${1:-}"; shift || true
case "$CMD" in
  pack)
    REPO="${1:-}"; shift || true
    [[ -n "$REPO" && -d "$REPO" ]] || die 4 "usage: repomix.sh pack <repo-path> [-- <args>]"
    [[ "${1:-}" == "--" ]] && shift || true
    # --- condition 4, CONTENT side (Cybersec NO-GO cm 2026-08-07): the flag refusal above only
    # closes the CLI surface. secretlint honours in-FILE `secretlint-disable` markers, so a file can
    # mute the scan of its own secret and the pack reports "No suspicious files detected" while the
    # secret sits in the output verbatim -- a proven bypass, not a theoretical one. Refuse the pack.
    # Deliberately a REFUSAL, not a warning: a warning on a bulk-export tool is read as noise.
    if MUTED=$(grep -rIl --exclude-dir=.git -e 'secretlint-disable' "$REPO" 2>/dev/null) && [[ -n "$MUTED" ]]; then
      echo "repomix.sh: REFUSED -- these files mute the secret scanner from their own content:" >&2
      printf '  %s\n' $MUTED >&2
      die 5 "remove the secretlint-disable markers, or pack a subtree that excludes them"
    fi
    # --- HONEST LIMIT 2, now closed on the shape axis (card 2f781b49, Cybersec). The bundled
    # secretlint covers AWS by KEYWORD anchor: an access key ID is never detected (not even named),
    # and the secret-key rule ends in `\b` while its own 40-char class contains `/`, `+`, `=` -- so
    # a secret ending in one of those silently passes (~3% of AWS-generated secrets; measured with
    # five files differing ONLY in the final character). This pre-filter runs a SHAPE-based scan
    # first, so a clean repomix Security Check is no longer the only thing standing between a
    # credential and the pack. It refuses rather than warns, for the same reason as the marker
    # guard above.
    if ! python3 "$(dirname "${BASH_SOURCE[0]}")/secret-shape-scan.py" "$REPO"; then
      die 7 "shape-based scan refused this tree (see above) -- remove the credentials, or pack a subtree that excludes them"
    fi
    mkdir -p "$OUT_DIR_DEFAULT"
    OUT="$OUT_DIR_DEFAULT/$(basename "$REPO")-pack.xml"
    # --security-check is upstream-default ON; passed explicitly so the intent is visible in logs.
    "$REPOMIX_BIN" --output "$OUT" "$@" "$REPO"
    echo "repomix.sh: pack written to $OUT (gitignored; treat as SENSITIVE -- never commit, never ship to an external model unreviewed)"
    ;;
  doctor)
    echo "binary:  $REPOMIX_BIN"
    echo "version: $("$REPOMIX_BIN" --version 2>&1 | head -1)"
    echo "pinned:  $PINNED_VERSION"
    echo "out-dir: $OUT_DIR_DEFAULT (gitignored)"
    command -v repomix >/dev/null 2>&1 \
      && echo "WARNING: a raw 'repomix' is on PATH ($(command -v repomix)) -- wrapper is bypassable, remove it" \
      || echo "path:    raw repomix NOT on PATH (OK)"
    ;;
  -h|--help|'') awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}" ;;
  *) die 4 "unknown subcommand '$CMD'; allowed: pack doctor" ;;
esac

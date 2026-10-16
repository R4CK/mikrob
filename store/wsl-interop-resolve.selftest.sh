#!/usr/bin/env bash
# wsl-interop-resolve.selftest.sh -- controls for wsl-interop-resolve.sh (card 73b500f9).
#
# Fixture fakes a "cmd.exe" that only succeeds for ONE specific WSL_INTEROP value, mirroring
# the real, measured shape on this host (2026-10-15): /run/WSL/1_interop and 2_interop both
# answer "Invalid argument", only 742_interop works. No real GPU/WSL host or root needed --
# everything is fake files in a scratch dir.
#
# Usage: store/wsl-interop-resolve.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/wsl-interop-resolve.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { # $1 = label, $2 = expected, $3 = actual
  if [ "$3" = "$2" ]; then echo "  ok   $1 -> $3"
  else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi
}

echo "wsl-interop-resolve controls"

# fake "cmd.exe": succeeds only if WSL_INTEROP equals the one live candidate.
mkfake_cmd() { # $1 = the ONE WSL_INTEROP value that should succeed (empty = none succeed)
  local p="$TMP/fake-cmd.exe" live="$1"
  { printf '#!/usr/bin/env bash\n'
    printf 'LIVE=%q\n' "$live"
    printf '[ -n "$LIVE" ] && [ "$WSL_INTEROP" = "$LIVE" ] && exit 0\n'
    printf 'echo "cmd.exe: Invalid argument" >&2; exit 1\n'
  } > "$p"
  chmod +x "$p"
  echo "$p"
}

# --- 1. EMPTY WSL_INTEROP, one dead candidate + one live candidate -> resolves to the live one.
DIR1="$TMP/run-wsl-1"; mkdir -p "$DIR1"
: > "$DIR1/1_interop"
: > "$DIR1/742_interop"
CMD1="$(mkfake_cmd "$DIR1/742_interop")"
out="$(WSL_INTEROP="" WSL_INTEROP_RESOLVE_CMD_EXE="$CMD1" WSL_INTEROP_RESOLVE_RUN_WSL_DIR="$DIR1" bash "$BIN")"
check "empty WSL_INTEROP: resolves to the live candidate" "$DIR1/742_interop" "$out"

# --- 2. DEAD WSL_INTEROP (set, but the probe against it fails) -> falls through to the live one,
#     not the original dead value -- this is the exact bug: a stale/dead value in WSL_INTEROP
#     must not be trusted just because it is non-empty.
DIR2="$TMP/run-wsl-2"; mkdir -p "$DIR2"
: > "$DIR2/2_interop"
: > "$DIR2/742_interop"
CMD2="$(mkfake_cmd "$DIR2/742_interop")"
out="$(WSL_INTEROP="$DIR2/2_interop" WSL_INTEROP_RESOLVE_CMD_EXE="$CMD2" WSL_INTEROP_RESOLVE_RUN_WSL_DIR="$DIR2" bash "$BIN")"
check "dead WSL_INTEROP: falls through to the live candidate, not the dead one" "$DIR2/742_interop" "$out"

# --- 3. WSL_INTEROP already points at a working socket -> returned unchanged, candidates untouched.
DIR3="$TMP/run-wsl-3"; mkdir -p "$DIR3"
: > "$DIR3/decoy_interop"
CMD3="$(mkfake_cmd "/already/working_interop")"
out="$(WSL_INTEROP="/already/working_interop" WSL_INTEROP_RESOLVE_CMD_EXE="$CMD3" WSL_INTEROP_RESOLVE_RUN_WSL_DIR="$DIR3" bash "$BIN")"
check "already-working WSL_INTEROP: returned as-is" "/already/working_interop" "$out"

# --- 4. ALL candidates dead -> prints nothing, exit 0 (fail-closed, not a crash).
DIR4="$TMP/run-wsl-4"; mkdir -p "$DIR4"
: > "$DIR4/1_interop"
: > "$DIR4/2_interop"
CMD4="$(mkfake_cmd "")"
out="$(WSL_INTEROP="" WSL_INTEROP_RESOLVE_CMD_EXE="$CMD4" WSL_INTEROP_RESOLVE_RUN_WSL_DIR="$DIR4" bash "$BIN")"
rc=$?
check "all dead: prints empty" "" "$out"
check "all dead: exit 0 (fail-closed, not a crash)" "0" "$rc"

# --- 5. candidate directory does not exist at all -> prints nothing, exit 0 (no crash).
CMD5="$(mkfake_cmd "")"
out="$(WSL_INTEROP="" WSL_INTEROP_RESOLVE_CMD_EXE="$CMD5" WSL_INTEROP_RESOLVE_RUN_WSL_DIR="$TMP/does-not-exist" bash "$BIN")"
rc=$?
check "missing run-wsl dir: prints empty" "" "$out"
check "missing run-wsl dir: exit 0 (no crash)" "0" "$rc"

echo
if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi

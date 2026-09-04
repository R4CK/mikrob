#!/usr/bin/env bash
# Self-test for skills-symlink-to-realdir.sh (card 7d2ebd24).
#
# Run:  bash store/skills-symlink-to-realdir.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# Hermetic: every case builds its own fake skills dir and fake vendor checkout under a temp dir and
# points the script at it with SKILLS_DIR. Nothing here touches ~/.claude, which matters because the
# thing under test REPLACES directories.
#
# THE CASE THAT JUSTIFIES THE WHOLE FILE is "the vendored tree is not polluted". The obvious
# implementation (`mv newdir link`) does not replace the link -- it moves the directory INSIDE the
# link's target, i.e. into somebody else's git repo. That was reproduced before the script was
# written, and it is the same write-through class that had already rewritten three files inside the
# vendored repo through `[ -d ]` on a symlink.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/skills-symlink-to-realdir.sh"
fail=0
n=0

ok() { n=$((n + 1)); printf 'OK   %s\n' "$1"; }
bad() { n=$((n + 1)); fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fixture() { # $1 = case dir
  local root="$TMP/$1"
  rm -rf "$root"
  mkdir -p "$root/vendor/alpha" "$root/vendor/beta" "$root/skills"
  printf 'alpha skill\n' > "$root/vendor/alpha/SKILL.md"
  printf 'alpha reference\n' > "$root/vendor/alpha/ref.md"
  printf 'beta skill\n' > "$root/vendor/beta/SKILL.md"
  ln -s "$root/vendor/alpha/" "$root/skills/sp-alpha"
  ln -s "$root/vendor/beta/" "$root/skills/sp-beta"
  echo "$root"
}

echo "skills-symlink-to-realdir selftest"

# --- the conversion itself -----------------------------------------------------------------
R="$(fixture basic)"
SKILLS_DIR="$R/skills" bash "$SCRIPT" >/dev/null 2>&1
chk "a symlinked skill becomes a REAL directory" \
    "$([ -L "$R/skills/sp-alpha" ] && echo symlink || ([ -d "$R/skills/sp-alpha" ] && echo realdir))" "realdir"
chk "every file survives the conversion" \
    "$(cat "$R/skills/sp-alpha/SKILL.md" 2>/dev/null)" "alpha skill"
chk "...including non-SKILL.md files" \
    "$(cat "$R/skills/sp-alpha/ref.md" 2>/dev/null)" "alpha reference"

# --- THE ONE THAT MATTERS -------------------------------------------------------------------
# `mv newdir link` would land the directory inside the vendored repo instead of replacing the link.
chk "the VENDORED tree is not polluted (no staged dir moved into it)" \
    "$(ls "$R/vendor/alpha" | tr '\n' ' ')" "SKILL.md ref.md "
chk "the vendored file itself is untouched" \
    "$(cat "$R/vendor/alpha/SKILL.md")" "alpha skill"

# --- independence, which is the point of the card -------------------------------------------
# After conversion, reverting the vendored checkout must not change what agents read.
printf 'REVERTED BY THE VENDOR\n' > "$R/vendor/alpha/SKILL.md"
chk "a later vendor revert no longer reaches the installed skill" \
    "$(cat "$R/skills/sp-alpha/SKILL.md")" "alpha skill"

# --- idempotence + hygiene -------------------------------------------------------------------
out="$(SKILLS_DIR="$R/skills" bash "$SCRIPT" 2>&1)"
chk "a second run converts nothing and reports them as already real" \
    "$(printf '%s' "$out" | grep -c 'converted 0, already real 2')" "1"
chk "no staging directory is left behind" \
    "$(find "$R/skills" -maxdepth 1 -name '.*realdir*' | wc -l | tr -d ' ')" "0"

# --- a DANGLING link is reported, not silently skipped ---------------------------------------
# `[ -e ]` follows the link, so a broken entry tests false; without an explicit -L test it would be
# skipped in silence and the run would still claim success.
R2="$(fixture dangling)"
ln -s "$R2/vendor/gone/" "$R2/skills/sp-dangling"
out2="$(SKILLS_DIR="$R2/skills" bash "$SCRIPT" 2>&1)"; rc2=$?
chk "a dangling symlink is REPORTED" "$(printf '%s' "$out2" | grep -c 'SKIP sp-dangling')" "1"
chk "...and it makes the run exit non-zero" "$([ "$rc2" -ne 0 ] && echo yes || echo no)" "yes"
chk "...and the dangling link is left alone" \
    "$([ -L "$R2/skills/sp-dangling" ] && echo yes || echo no)" "yes"

# --- a failed copy must not touch the link ----------------------------------------------------
R3="$(fixture readonly)"
chmod 000 "$R3/vendor/beta" 2>/dev/null || true
SKILLS_DIR="$R3/skills" bash "$SCRIPT" >/dev/null 2>&1
chmod 755 "$R3/vendor/beta" 2>/dev/null || true
chk "a skill whose source could not be read is left exactly as it was" \
    "$([ -L "$R3/skills/sp-beta" ] || [ -d "$R3/skills/sp-beta" ] && echo present || echo LOST)" "present"

# --- --check changes nothing -------------------------------------------------------------------
R4="$(fixture checkmode)"
SKILLS_DIR="$R4/skills" bash "$SCRIPT" --check >/dev/null 2>&1
chk "--check leaves every symlink a symlink" \
    "$(find "$R4/skills" -maxdepth 1 -type l | wc -l | tr -d ' ')" "2"

echo
if [ "$fail" -eq 0 ]; then echo "selftest: $n case(s), PASS"; exit 0; fi
echo "selftest: $n case(s), $fail FAILED"; exit 1

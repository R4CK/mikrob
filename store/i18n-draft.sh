#!/usr/bin/env bash
# i18n-draft.sh -- offload i18n translation DRAFTS to the local LLM (card 4245417b).
#
# PURPOSE: for a target locale, find every key the SOURCE (EN) has but the locale is MISSING,
# and draft each translation on the local GPU model (local-llm.sh --task translate) instead of
# burning online Claude tokens. Output is a SEPARATE <lang>.draft.json for human/gate review --
# it NEVER overwrites the real locale file. Namespaces are derived from the SOURCE file's REAL
# structure (all top-level keys, recursively), NOT a hardcoded allowlist -- so a new namespace
# (e.g. vertical.*) can never slip through as a blind spot.
#
# USAGE:
#   i18n-draft.sh --messages-dir <dir> --lang <de|es|fr|it|pl|...> [--source en] [--limit N] [--out <file>]
# EXAMPLE:
#   i18n-draft.sh --messages-dir /path/to/packages/i18n/messages --lang de --limit 30
#
# Draft-only: the .draft.json is reviewed/merged by a human + the i18n gate before shipping.
# No secrets; no hardcoded project paths (pass --messages-dir). Ollama must be up (local-llm.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_SH="$SCRIPT_DIR/local-llm.sh"

MSG_DIR=""; LANG_CODE=""; SOURCE="en"; LIMIT="40"; OUT=""
die() { echo "i18n-draft: $2" >&2; exit "$1"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --messages-dir) MSG_DIR="$2"; shift 2 ;;
    --lang)         LANG_CODE="$2"; shift 2 ;;
    --source)       SOURCE="$2"; shift 2 ;;
    --limit)        LIMIT="$2"; shift 2 ;;
    --out)          OUT="$2"; shift 2 ;;
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die 4 "unknown arg '$1'; see --help" ;;
  esac
done
[[ -n "$MSG_DIR" ]] || die 4 "--messages-dir is required"
[[ -n "$LANG_CODE" ]] || die 4 "--lang is required"
[[ -x "$LLM_SH" ]] || die 4 "local-llm.sh not found/executable at $LLM_SH"

# VRAM PRESSURE (card 108c7b10). Checked BEFORE any locale file is read: every step after this one
# exists only to feed the model, so asking the GPU first is the cheap order here (the opposite of
# local-llm-rag.sh, where the content router can decide `online` without spending an nvidia-smi).
#
# Exit 3, NOT 4: code 4 in this script means the caller passed something wrong, and a full GPU is not
# a usage error -- it is a capacity condition the caller can retry unchanged. A separate code lets a
# wrapper tell "fix your arguments" from "try again later". Missing guard -> skipped; any non-zero
# exit from it -> no draft, same direction as every other call site.
VRAM_GUARD="${I18N_DRAFT_VRAM_GUARD:-$SCRIPT_DIR/vram-guard-check.sh}"
if [[ -f "$VRAM_GUARD" ]]; then
  # `|| vram_rc=$?` rather than `; vram_rc=$?` -- this script runs under `set -e`, unlike the three
  # call sites card f9bad591 wired, so a HOLD from the guard would kill the script AT THE ASSIGNMENT
  # and never reach the check below. Measured: exit 1 with an empty stderr, i.e. the message that
  # explains what happened never printed. The selftest caught it.
  vram_rc=0
  vram_line="$(bash "$VRAM_GUARD" 2>/dev/null)" || vram_rc=$?
  [[ "$vram_rc" -eq 0 ]] || die 3 "the local model cannot take work now (${vram_line:-no output}, rc=$vram_rc) -- NO draft was written; re-run when the GPU frees up"
fi
EN_PATH="$MSG_DIR/$SOURCE.json"; LANG_PATH="$MSG_DIR/$LANG_CODE.json"
[[ -f "$EN_PATH" ]] || die 4 "source locale not found: $EN_PATH"
[[ -f "$LANG_PATH" ]] || die 4 "target locale not found: $LANG_PATH"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || die 4 "--limit must be a non-negative integer"
[[ -n "$OUT" ]] || OUT="$MSG_DIR/$LANG_CODE.draft.json"

# Human-readable language name for the translation prompt (fallback: the code itself).
case "$LANG_CODE" in
  de) LANGNAME="German" ;; es) LANGNAME="Spanish" ;; fr) LANGNAME="French" ;;
  it) LANGNAME="Italian" ;; pl) LANGNAME="Polish" ;; hu) LANGNAME="Hungarian" ;;
  nl) LANGNAME="Dutch" ;; pt) LANGNAME="Portuguese" ;; *) LANGNAME="$LANG_CODE" ;;
esac

EN_PATH="$EN_PATH" LANG_PATH="$LANG_PATH" OUT_PATH="$OUT" LIMIT="$LIMIT" \
LANG_CODE="$LANG_CODE" LANGNAME="$LANGNAME" LLM_SH="$LLM_SH" python3 - <<'PY'
import json, os, subprocess

en = json.load(open(os.environ['EN_PATH'], 'r', encoding='utf-8'))
cur = json.load(open(os.environ['LANG_PATH'], 'r', encoding='utf-8'))

def flatten(d, prefix=''):
    flat = {}
    for k, v in d.items():
        nk = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, nk))
        else:
            flat[nk] = v
    return flat

flat_en, flat_cur = flatten(en), flatten(cur)
# Missing = present in the EN source (real namespaces), absent in the target locale.
missing = [(k, v) for k, v in flat_en.items() if k not in flat_cur and isinstance(v, str)]

out, drafted = {}, 0
for k, v in missing[:int(os.environ['LIMIT'])]:
    r = subprocess.run(
        [os.environ['LLM_SH'], '--task', 'translate', '--caller', 'i18n-draft',
         f"Target language: {os.environ['LANGNAME']} ({os.environ['LANG_CODE']}). String: {v}"],
        capture_output=True, text=True)
    draft = (r.stdout or '').strip()
    if not draft:
        continue
    node = out
    parts = k.split('.')
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = draft
    drafted += 1

json.dump(out, open(os.environ['OUT_PATH'], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f"candidates={len(missing)} drafted={drafted} out={os.environ['OUT_PATH']}")
PY

#!/usr/bin/env bash
# first-run-llm.sh -- post-boot local-LLM setup. Card fbbb4015 (EPIC ebc7b4dd, T2).
#
# WHAT CHANGED AND WHY. The installer used to install Ollama and pull a coding model by itself.
# Peti's directive (2026-08-13): it must not. The user picks a model from a catalogue filtered to
# what their GPU can actually run, and starts the install themselves. Ollama stays the runtime --
# only the SILENT pre-install goes away.
#
# THE ORDER HERE IS THE POINT, and it is not the obvious one:
#
#   1. runtime        -- offered, never silent. Nothing else can happen without it.
#   2. EMBEDDING model -- automatic, small (~274 MB), GPU-independent, and NOT part of the choice.
#                        Semantic memory search depends on it; if it were bundled into the coding
#                        model decision, a user who declines the coding model would silently lose
#                        memory search and never learn why. It is not a preference, it is a
#                        dependency (MikroB decision, 2026-08-13).
#   3. CODING model   -- offered from the catalogue, and only after 1 and 2 have succeeded.
#
# WHAT IT REFUSES TO DO: write store/local-llm-model as a side effect of an install. That write is
# its own explicit, logged step (card 87d7c86f), because "the download finished" is not evidence the
# model produces usable code, and a model that quietly becomes the fleet default has never been
# measured. A freshly installed model is INSTALLED, not IN USE, until someone says so.
#
# Non-interactive by default: with no TTY it PRINTS what it would offer and exits 0. An installer
# that pops a prompt into a pipe is an installer that hangs.
#
# Usage:
#   store/first-run-llm.sh              # interactive when a TTY is present, otherwise a dry report
#   store/first-run-llm.sh --status     # what is present / missing, no changes, no network
#   store/first-run-llm.sh --yes        # non-interactive: runtime + embedding only, no coding model
#   store/first-run-llm.sh --use <tag> [--i-trust <publisher>]
#                                       # make an installed model the fleet default. A publisher
#                                       # outside store/llm-catalog-trust.json needs --i-trust.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_FILE="$HERE/local-llm-model"
LOG="$HERE/first-run-llm.log"
EMBED_MODEL="${FIRST_RUN_EMBED_MODEL:-nomic-embed-text}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_BIN="${FIRST_RUN_OLLAMA_BIN:-ollama}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }
say() { printf '%s\n' "$*"; }

have_runtime() { command -v "$OLLAMA_BIN" >/dev/null 2>&1; }
runtime_up()  { curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }
have_model()  { # $1 = model name
  curl -fsS -m 5 "$OLLAMA_HOST/api/tags" 2>/dev/null \
    | python3 -c 'import json,sys;n=sys.argv[1];print("yes" if any((m.get("name") or "").split(":")[0]==n.split(":")[0] for m in json.load(sys.stdin).get("models",[])) else "no")' "$1" 2>/dev/null
}

status() {
  say "runtime ($OLLAMA_BIN):   $(have_runtime && echo installed || echo MISSING)"
  say "runtime api:            $(runtime_up && echo up || echo down)"
  say "embedding model:        $( [ "$(have_model "$EMBED_MODEL")" = yes ] && echo present || echo MISSING ) ($EMBED_MODEL)"
  if [ -s "$MODEL_FILE" ]; then say "coding model in use:    $(tr -d '[:space:]' < "$MODEL_FILE")"
  else say "coding model in use:    none configured"; fi
}

[ "${1:-}" = "--status" ] && { status; exit 0; }

# --use <tag>: the EXPLICIT, LOGGED default switch that card 87d7c86f requires. Installing a model
# must never write this file as a side effect -- "the download finished" is not evidence that the
# model produces usable code, and a model that quietly became the fleet default has never been
# measured by anyone. Separating the two is the whole point, so this is a separate verb.
#
# It REFUSES a model the runtime does not actually have. Pointing the fleet at a missing model does
# not fail loudly at switch time; it fails later, inside every agent that tries to draft, which is
# the worst place to discover it.
if [ "${1:-}" = "--use" ]; then
  want="${2:-}"
  # --i-trust <publisher>: the operator's answer to the trust gate further down. It is a separate
  # argument rather than a yes/no so that answering it requires having read the publisher name.
  ITRUST=""
  [ "${3:-}" = "--i-trust" ] && ITRUST="${4:-}"
  [ -n "$want" ] || { say "usage: first-run-llm.sh --use <model-tag> [--i-trust <publisher>]"; exit 2; }
  if ! runtime_up; then
    say "The runtime is not answering at $OLLAMA_HOST -- start it, then retry."
    exit 3
  fi
  if [ "$(have_model "$want")" != "yes" ]; then
    say "The runtime does not have '$want'. Install it first:"
    say "    $OLLAMA_BIN pull $want"
    say "(refusing to point the fleet at a model that is not there)"
    exit 4
  fi
  # DIGEST VERIFICATION, and it is a real one (card 429dadb2). Cybered's point stood: recording a
  # sha256 that nothing ever compares is documentation, not a control.
  #
  # MEASURED 2026-08-13, which is what makes the strong form possible: ollama stores a pulled GGUF
  # VERBATIM in a content-addressed blob, so the blob filename is the sha256 of the bytes on disk --
  # and for `ollama pull hf.co/<repo>:<QUANT>` that digest EQUALS the HF lfs.oid. Pulled
  # hf.co/RichardErkhov/bigcode_-_tiny_starcoder_py-gguf:Q2_K and found
  # blobs/sha256-aa8c2170...1f41, exactly the oid the catalogue recorded. So we can compare what
  # LANDED against what was CATALOGUED, not merely re-ask the registry what it claims today.
  #
  # A model with no catalogue entry (e.g. the registry.ollama.ai default this fleet already runs)
  # cannot be verified this way. That is reported LOUDLY rather than silently passed or refused:
  # blocking it would break a working fleet, and pretending it was verified would be a lie.
  BLOBS="${FIRST_RUN_BLOBS:-$HOME/.ollama/models/blobs}"
  verdict="unverified-not-in-catalogue"
  cache="$HERE/llm-catalog-cache.json"
  if [ -f "$cache" ]; then
    verdict="$(WANT="$want" BLOBS="$BLOBS" python3 -c '
import json, os, sys
want, blobs = os.environ["WANT"], os.environ["BLOBS"]
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    print("unverified-no-catalogue"); raise SystemExit
m = next((x for x in doc.get("models", []) if x.get("installRef") == want), None)
if m is None:
    print("unverified-not-in-catalogue"); raise SystemExit
missing = [p["path"] for p in m.get("parts", [])
           if not p.get("sha256") or not os.path.exists(os.path.join(blobs, "sha256-" + p["sha256"]))]
print("ok" if not missing else "MISMATCH:" + ",".join(missing[:3]))
' "$cache" 2>/dev/null || echo unverified-error)"
  fi
  case "$verdict" in
    ok)
      say "digest check: OK -- every part matches the sha256 recorded when it was catalogued."
      log "digest check ok: $want" ;;
    MISMATCH:*)
      # REFUSE. The bytes on disk are not the bytes we catalogued, and this model is about to become
      # the fleet's code-suggesting oracle.
      say "DIGEST MISMATCH -- refusing to make '$want' the fleet default."
      say "  These parts are not present with the catalogued digest: ${verdict#MISMATCH:}"
      say "  The weights on disk are not the weights that were catalogued. Re-pull, or re-run"
      say "  python3 store/llm-catalog.py if the upstream repo legitimately changed."
      log "digest check FAILED: $want (${verdict#MISMATCH:})"
      exit 6 ;;
    *)
      say "digest check: NOT POSSIBLE ($verdict)."
      say "  This model has no catalogue entry, so its provenance is UNVERIFIED. Proceeding, but"
      say "  it is not covered by the digest control."
      log "digest check skipped: $want ($verdict)" ;;
  esac

  # PUBLISHER TRUST GATE (card eb843c46). The digest check above answers "are these the bytes we
  # catalogued". It says NOTHING about whether the PUBLISHER should be trusted with this job: a
  # faithfully delivered backdoor matches its own digest perfectly. Those are two different
  # questions with two different lists and two different lifecycles -- relevance ("is this a coding
  # model", cheap data edit) versus trust ("may this be installed", security control), which is why
  # store/llm-catalog-trust.json keeps them apart.
  #
  # For a publisher OUTSIDE trustedPublishers the decision is the operator's, not this script's, and
  # a confirmation that shows only a name is a click-through rather than a decision. So the gate
  # prints what the decision actually rests on -- publisher, downloads, part count, full digests --
  # and then requires the operator to NAME the publisher back. Reading is the point; a bare y/N
  # could be answered without looking.
  #
  # It behaves identically with and without a TTY on purpose. A gate that auto-accepts in a pipe is
  # not a gate, and one that can only ever be answered by hand would make an untrusted model
  # impossible to adopt at all -- so the escape hatch is one explicit, logged flag.
  BASIS="$(WANT="$want" python3 -c '
import json, os, sys
want = os.environ["WANT"]
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    doc = {}
m = next((x for x in doc.get("models", []) if x.get("installRef") == want), None)
if m is None:
    # No entry means no provenance at all, which is strictly weaker than an untrusted publisher --
    # so it goes through the same gate, under a name the operator has to type deliberately.
    print("no\tunverified\tunknown\t0")
    print("      (no catalogue entry -- nothing is recorded about where these weights came from)")
else:
    parts = m.get("parts") or []
    dl = m.get("downloads")
    print("%s\t%s\t%s\t%d" % ("yes" if m.get("trusted") else "no",
                              m.get("repoOwner") or "unknown",
                              "unknown" if dl is None else dl,
                              len(parts)))
    for p in parts:
        # Never truncated: a shortened digest cannot be compared against anything.
        print("      %s  %s" % (p.get("sha256") or "MISSING", p.get("path") or "?"))
    if not parts:
        print("      (no parts recorded)")
' "$cache" 2>/dev/null)"
  [ -n "$BASIS" ] || BASIS="$(printf 'no\tunverified\tunknown\t0\n      (catalogue unreadable)')"
  IFS="$(printf '\t')" read -r T_TRUSTED T_OWNER T_DOWNLOADS T_PARTS <<< "$(printf '%s\n' "$BASIS" | head -1)"
  if [ "$T_TRUSTED" != "yes" ]; then
    say ""
    say "UNTRUSTED PUBLISHER -- '$T_OWNER' is not on the installable-trust list"
    say "  (store/llm-catalog-trust.json -> trustedPublishers). This step makes the model the"
    say "  code-suggesting oracle for every agent in the fleet, so the call is yours."
    say ""
    say "  What the decision rests on:"
    say "    model:      $want"
    say "    publisher:  $T_OWNER"
    say "    downloads:  $T_DOWNLOADS"
    say "    parts:      $T_PARTS"
    say "    digests:"
    printf '%s\n' "$BASIS" | tail -n +2
    if [ -n "$ITRUST" ] && [ "$(printf '%s' "$ITRUST" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$T_OWNER" | tr '[:upper:]' '[:lower:]')" ]; then
      say ""
      say "  Accepted: you named the publisher explicitly. Recorded in $LOG."
      log "untrusted default ACCEPTED: $want (publisher $T_OWNER, downloads $T_DOWNLOADS, parts $T_PARTS, explicit --i-trust)"
    else
      say ""
      say "  Not making it the default. If you have read the above and still want it, name the"
      say "  publisher back:"
      say "      store/first-run-llm.sh --use $want --i-trust $T_OWNER"
      log "untrusted default REFUSED: $want (publisher $T_OWNER, no matching --i-trust)"
      exit 7
    fi
  fi

  prev="$( [ -s "$MODEL_FILE" ] && tr -d '[:space:]' < "$MODEL_FILE" || echo '<none>' )"
  printf '%s\n' "$want" > "$MODEL_FILE" || { say "could not write $MODEL_FILE"; exit 5; }
  log "default model: $prev -> $want (explicit --use)"
  say "Fleet default is now: $want   (was: $prev)"
  say "NOT YET BENCHMARKED on this hardware -- run store/local-llm-bench.sh before trusting its"
  say "throughput numbers, and treat its drafts as drafts until then."
  exit 0
fi

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1
INTERACTIVE=0
{ [ -t 0 ] && [ -t 1 ]; } && INTERACTIVE=1

ask() { # $1 = prompt; yes -> 0
  [ "$ASSUME_YES" = "1" ] && return 0
  [ "$INTERACTIVE" = "1" ] || return 1
  local a; read -r -p "$1 [y/N] " a </dev/tty || return 1
  case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}

say ""
say "Local LLM setup (nothing is installed without your consent)"
say "-----------------------------------------------------------"

# --- 1. runtime ----------------------------------------------------------------------------------
if ! have_runtime; then
  say "The local-LLM runtime (Ollama) is not installed."
  say "It is required for semantic memory search and for any local model."
  if ask "  Install it now?"; then
    log "runtime install: starting"
    if curl -fsSL https://ollama.com/install.sh | sh; then
      log "runtime install: ok"; say "  runtime installed."
    else
      # NON-FATAL, deliberately: this script runs after boot, not during a deploy. Failing here must
      # leave a working system with a clear next step, not a half-configured one.
      log "runtime install: FAILED"
      say "  Install failed. Retry later with: curl -fsSL https://ollama.com/install.sh | sh"
      exit 0
    fi
  else
    say "  Skipped. Semantic memory search stays keyword-only until a runtime is installed."
    say "  Re-run any time: store/first-run-llm.sh"
    log "runtime install: declined"
    exit 0
  fi
fi

runtime_up || { systemctl --user start ollama 2>/dev/null || true; sleep 2; }

# --- 2. embedding model: a DEPENDENCY, not a preference ------------------------------------------
if [ "$(have_model "$EMBED_MODEL")" != "yes" ]; then
  say ""
  say "Fetching the embedding model ($EMBED_MODEL, ~274 MB) -- required for semantic memory search."
  log "embed pull: starting $EMBED_MODEL"
  if "$OLLAMA_BIN" pull "$EMBED_MODEL" >/dev/null 2>&1; then
    log "embed pull: ok"; say "  done."
  else
    log "embed pull: FAILED"
    say "  Could not fetch it. Memory search stays keyword-only; retry: $OLLAMA_BIN pull $EMBED_MODEL"
  fi
fi

# --- 3. coding model: OFFERED, from the VRAM-filtered catalogue -----------------------------------
say ""
if [ -s "$MODEL_FILE" ]; then
  say "A coding model is already configured: $(tr -d '[:space:]' < "$MODEL_FILE")"
  # Point at the verb that actually works. Saying "re-run this script" would be a dead instruction:
  # with a model configured we exit right here and never reach the catalogue.
  say "To change it:  $OLLAMA_BIN pull <tag>   then   store/first-run-llm.sh --use <tag>"
  say "To see what else fits this machine:  python3 store/llm-catalog.py"
  exit 0
fi

say "Choosing a coding model. Reading your GPU..."
GPU_JSON="$(bash "$HERE/gpu-detect.sh" 2>/dev/null)"
printf '%s' "$GPU_JSON" | python3 -c '
import json,sys
try: g=json.load(sys.stdin)
except Exception: sys.exit(0)
name=g.get("name") or "no GPU detected"
if g.get("vramTotalMib"): print("  %s -- %d MiB VRAM (probe: %s)" % (name, g["vramTotalMib"], g.get("detectedBy")))
else: print("  %s -- size unknown, entries will be filtered against system RAM" % name)
' 2>/dev/null

CATALOG="$(python3 "$HERE/llm-catalog.py" 2>/dev/null)"
COUNT="$(printf '%s' "$CATALOG" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin).get("models",[])))
except Exception: print(0)' 2>/dev/null)"

if [ "${COUNT:-0}" -eq 0 ]; then
  say "  No catalogue available right now (offline, or nothing fits this machine)."
  say "  Re-run later: store/first-run-llm.sh"
  log "catalog: empty"
  exit 0
fi

say ""
say "  Models that fit this machine (top 5 of $COUNT):"
printf '%s' "$CATALOG" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for i,m in enumerate(d["models"][:5],1):
    trust = "trusted publisher" if m.get("trusted") else "UNVERIFIED publisher"
    note = (" -- " + m["notes"][0]) if m.get("notes") else ""
    print("   %d) %-42s %-8s %5.1f GB  %-7s  %s%s"
          % (i, m["repo"][:42], m["quant"], m["fileMib"]/1024, m["tier"], trust, note))
' 2>/dev/null

say ""
say "  Nothing is downloaded until you choose. To install one:"
say "    $OLLAMA_BIN pull <installRef from the catalogue>"
say "  Then make it the fleet default -- a SEPARATE, deliberate step:"
say "    store/first-run-llm.sh --use <model-tag>"
log "catalog: offered $COUNT models, none installed"
exit 0

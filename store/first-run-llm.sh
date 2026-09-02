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
# The one catalogue schema this build knows how to read (card 4117f98e). Bump it in the same
# change that teaches this script the new shape -- never ahead of it.
SUPPORTED_CATALOG_SCHEMA=1

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
  # card baf1b1b0: a second, task-routed model, checked directly against Ollama (never in
  # $MODEL_FILE -- it is a routing override, not the default) so --status reports reality even if
  # store/local-llm-model-routing.json were ever missing or stale.
  say "HU specialist model:    $( [ "$(have_model "hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M")" = yes ] && echo present || echo "not installed" )"
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
parts = m.get("parts") or []
# An entry with no parts USED TO print "digest check: OK -- every part matches", because an empty
# list has no mismatches (Cybersec F2). Verifying nothing and verifying successfully are different
# claims, and the confident wording is worse than silence: it lends authority to an entry nobody
# checked. Today no real catalogue entry is partless (0 of 435), so this is reachable only by a
# hand-written cache -- which is exactly the situation where the false reassurance would land.
if not parts:
    print("unverified-no-parts"); raise SystemExit
missing = [p["path"] for p in parts
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
  #
  # WHERE THE DECISION COMES FROM, which is the part the first version got wrong (Cybersec F1). It
  # read the `trusted` BOOLEAN stored in llm-catalog-cache.json -- a gitignored, unreviewed, agent-
  # writable file where that flag was frozen at catalogue-BUILD time. Two consequences, both proven
  # with a two-way control: flipping only that cached flag walked straight past the gate, and
  # removing a publisher from the reviewed list changed nothing for entries already cached, so the
  # control could be edited but not enforced. The cache now supplies FACTS ONLY (owner, downloads,
  # parts, digests) and the DECISION is recomputed here, at decision time, from the tracked and
  # reviewed store/llm-catalog-trust.json. An unreadable or missing trust list means NOT trusted.
  TRUST_FILE="$HERE/llm-catalog-trust.json"
  BASIS="$(WANT="$want" TRUSTFILE="$TRUST_FILE" python3 -c '
import json, os, sys
want = os.environ["WANT"]
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    doc = {}
# The reviewed list, read fresh on every decision. Fail closed: no list, no trust.
try:
    trusted_pubs = {str(p).strip().lower()
                    for p in json.load(open(os.environ["TRUSTFILE"])).get("trustedPublishers", [])}
except Exception:
    trusted_pubs = set()
m = next((x for x in doc.get("models", []) if x.get("installRef") == want), None)
if m is None:
    # No entry means no provenance at all, which is strictly weaker than an untrusted publisher --
    # so it goes through the same gate, under a name the operator has to type deliberately.
    print("no\tunverified\tunknown\t0")
    print("      (no catalogue entry -- nothing is recorded about where these weights came from)")
else:
    parts = m.get("parts") or []
    dl = m.get("downloads")
    owner = (m.get("repoOwner") or "unknown").strip()
    # NOT m.get("trusted"): that is the cached opinion. This is the current one.
    print("%s\t%s\t%s\t%d" % ("yes" if owner.lower() in trusted_pubs else "no",
                              owner,
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
  # WHAT THE OPERATOR HAS TO TYPE BACK (Cybersec F3). Naming the publisher works as a
  # read-the-screen check only while the name varies. For a model with no catalogue entry the owner
  # is the literal string "unverified" -- the same answer for every model, memorised once and typed
  # forever after -- so the case carrying the LEAST information had the weakest confirmation. There
  # the answer is the model tag instead, which differs per model.
  T_ANSWER="$T_OWNER"
  [ "$T_OWNER" = "unverified" ] && T_ANSWER="$want"
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
    if [ -n "$ITRUST" ] && [ "$(printf '%s' "$ITRUST" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$T_ANSWER" | tr '[:upper:]' '[:lower:]')" ]; then
      say ""
      say "  Accepted: you named it explicitly. Recorded in $LOG."
      log "untrusted default ACCEPTED: $want (publisher $T_OWNER, downloads $T_DOWNLOADS, parts $T_PARTS, explicit --i-trust)"
    else
      say ""
      say "  Not making it the default. If you have read the above and still want it, name it back:"
      say "      store/first-run-llm.sh --use $want --i-trust $T_ANSWER"
      log "untrusted default REFUSED: $want (publisher $T_OWNER, no matching --i-trust)"
      exit 7
    fi
  fi

  prev="$( [ -s "$MODEL_FILE" ] && tr -d '[:space:]' < "$MODEL_FILE" || echo '<none>' )"
  printf '%s\n' "$want" > "$MODEL_FILE" || { say "could not write $MODEL_FILE"; exit 5; }
  log "default model: $prev -> $want (explicit --use)"
  say "Fleet default is now: $want   (was: $prev)"
  # The benchmark warning is now a FACT, not a fixed line (card d730070e). It used to print on every
  # switch, including for a model measured five minutes earlier, and a warning that is always there
  # is one nobody reads. store/local-llm-model-state.json is written only by local-llm-bench.sh, and
  # only on a run that succeeded.
  BENCH="$(WANT="$want" python3 -c '
import json, os, sys
try:
    rec = (json.load(open(sys.argv[1])).get("models") or {}).get(os.environ["WANT"])
except Exception:
    rec = None
if rec and rec.get("benchmarkedAt"):
    print("%s\t%s" % (rec["benchmarkedAt"], rec.get("evalTps") or "?"))
' "$HERE/local-llm-model-state.json" 2>/dev/null)"
  if [ -n "$BENCH" ]; then
    say "Benchmarked on this hardware: ${BENCH%%	*} (${BENCH##*	} tok/s)."
  else
    say "NOT YET BENCHMARKED on this hardware -- run store/local-llm-bench.sh before trusting its"
    say "throughput numbers, and treat its drafts as drafts until then."
  fi
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
PRIMARY_ALREADY_SET=0
if [ -s "$MODEL_FILE" ]; then
  PRIMARY_ALREADY_SET=1
  say "A coding model is already configured: $(tr -d '[:space:]' < "$MODEL_FILE")"
  # Point at the verb that actually works. Saying "re-run this script" would be a dead instruction:
  # with a model configured, the catalogue below is never reached.
  say "To change it:  $OLLAMA_BIN pull <tag>   then   store/first-run-llm.sh --use <tag>"
  say "To see what else fits this machine:  python3 store/llm-catalog.py"
fi
if [ "$PRIMARY_ALREADY_SET" = "0" ]; then

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
# SCHEMA CHECK BEFORE READING ANY FIELD (card 4117f98e). The catalogue carries a schemaVersion so
# that a consumer meeting a document it does not understand REFUSES it, instead of reading fields
# that may have moved -- and this is a consumer that turns those fields into install instructions.
# The producer has enforced its own version since day one; this side never looked, which made the
# guard decorative on exactly the path it was written for.
#
# 0 models and an unknown version are different failures, so they get different messages: one means
# "nothing fits", the other means "this build cannot read this file".
CATALOG_SCHEMA="$(printf '%s' "$CATALOG" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("schemaVersion"))
except Exception: print("none")' 2>/dev/null)"
if [ "$CATALOG_SCHEMA" != "$SUPPORTED_CATALOG_SCHEMA" ]; then
  say "  The catalogue is version '$CATALOG_SCHEMA'; this build understands $SUPPORTED_CATALOG_SCHEMA."
  say "  Not reading it: a document from another schema may have moved the fields this step turns"
  say "  into install instructions. Update MikroB (./update.sh), then re-run store/first-run-llm.sh."
  log "catalog: unsupported schemaVersion '$CATALOG_SCHEMA' (understood: $SUPPORTED_CATALOG_SCHEMA)"
  exit 0
fi
COUNT="$(printf '%s' "$CATALOG" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin).get("models",[])))
except Exception: print(0)' 2>/dev/null)"

if [ "${COUNT:-0}" -eq 0 ]; then
  say "  No catalogue available right now (offline, or nothing fits this machine)."
  say "  Re-run later: store/first-run-llm.sh"
  log "catalog: empty"
  exit 0
fi

# WHERE THIS LIST CAME FROM, said out loud (card 3f6087f4, Cybered's LOW). The envelope has carried
# `stale` and `source` since it was written and NOTHING outside the JSON read them -- so an operator
# choosing from a frozen, shipped-in-the-repo fallback saw exactly what a live catalogue looks like.
# That matters here more than in most places: the digests on screen are the evidence for the trust
# label, and "as of generatedAt" is part of what that evidence means.
STALE_NOTE="$(printf '%s' "$CATALOG" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("stale"):
    print("this list is NOT live -- source: %s, recorded %s"
          % (d.get("source") or "unknown", d.get("generatedAt") or "unknown"))' 2>/dev/null)"
if [ -n "$STALE_NOTE" ]; then
  say ""
  say "  NOTE: $STALE_NOTE"
  say "  The entries and their digests are as of that moment; a newer or better model may exist now."
  log "catalog: stale envelope surfaced to the operator"
fi

say ""
say "  Models that fit this machine (top 5 of $COUNT):"
printf '%s' "$CATALOG" | TRUSTFILE="$HERE/llm-catalog-trust.json" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
# Same rule as the gate: the label is recomputed from the reviewed list, not read from the cached
# flag. A publisher removed after an incident must stop being shown as trusted immediately, not
# whenever someone next rebuilds the catalogue -- and the label the operator reads here must agree
# with the decision the gate will make later.
try:
    pubs = {str(p).strip().lower()
            for p in json.load(open(os.environ["TRUSTFILE"])).get("trustedPublishers", [])}
except Exception:
    pubs = set()
unverified = 0
for i,m in enumerate(d["models"][:5],1):
    ok = (m.get("repoOwner") or "").strip().lower() in pubs
    if not ok: unverified += 1
    trust = "trusted publisher" if ok else "UNVERIFIED publisher"
    note = (" -- " + m["notes"][0]) if m.get("notes") else ""
    # NAME LINE: no truncation. The old line cut the repo at 42 characters with no marker, and 45%
    # of a live 435-model catalogue is longer than that -- so what an operator read as a name was
    # routinely a prefix of one (Cybered, card a34effcb). A wrapped long line is a cosmetic problem;
    # a silently shortened identifier is a wrong one.
    print("   %d) %s  %s  %.1f GB  %s  %s%s"
          % (i, m["repo"], m["quant"], m["fileMib"]/1024, m["tier"], trust, note))
    # EVIDENCE LINE: the label has to be checkable. "A confirmation that shows only a name is a
    # click-through, not a decision" (T1) applies to the offer as much as to the confirm dialog, so
    # the two facts the catalogue already carries go next to the label: how many people pulled it,
    # and what the artefact hashes to. sha256 lives per PART, not on the model (measured: 0 of 435
    # carry a top-level sha256, 435 of 435 carry parts) -- and when a part carries none, the line
    # SAYS so rather than leaving the reader to assume the digest was checked.
    parts = m.get("parts") or []
    # Cybered LOW-2 (card d7220a73): this used to read only parts[0].sha256, so a set that was
    # pinned on part 0 and NOT on the rest printed "sha256 <hash> (N parts)" -- identical to a fully
    # pinned entry. Re-derived from every part, the same rule the `pinned` field in
    # store/llm-catalog.py and its validate() now enforce, not trusted from a cached flag that could drift.
    first_sha = (parts[0].get("sha256") or "") if parts else ""
    pinned_count = sum(1 for p in parts if p.get("sha256"))
    if not first_sha:
        dig = "no digest published"
    elif len(parts) == 1:
        dig = "sha256 " + first_sha[:12]
    elif pinned_count == len(parts):
        dig = "sha256 %s (%d parts, all pinned)" % (first_sha[:12], len(parts))
    else:
        dig = "sha256 %s (%d/%d parts pinned -- INCOMPLETE)" % (first_sha[:12], pinned_count, len(parts))
    dl = m.get("downloads")
    dl = ("%d downloads" % dl) if isinstance(dl, int) else "download count unknown"
    print("      %s | %s" % (dl, dig))
    # PULL LINE: the exact string to type. The instruction below used to say "pull <installRef from
    # the catalogue>" while the only ref on screen was the truncated repo -- and repo is not a
    # pullable ref at all: it lacks the hf.co prefix and the quant tag that select the artefact.
    print("      pull: %s" % (m.get("installRef") or "(no installRef in the catalogue entry)"))
if unverified:
    # Ordering is (tier, trusted, downloads) in llm-catalog.py, so within one tier the reviewed
    # publishers come first. An UNVERIFIED entry this high therefore carries information: nothing
    # trusted was left at that size. That is a fact worth stating rather than leaving as an absence.
    print("")
    print("   %d of the %d above are from publishers NOT on the reviewed list. They are shown"
          % (unverified, min(5, len(d["models"]))))
    print("   because within a size tier the reviewed ones are listed first -- so nothing trusted")
    print("   remained that fits this machine at that size, not because they were vouched for.")
' 2>/dev/null

say ""
say "  Nothing is downloaded until you choose. To install one, copy its pull: line above:"
say "    $OLLAMA_BIN pull hf.co/<publisher>/<repo>:<quant>"
say "  Then make it the fleet default -- a SEPARATE, deliberate step:"
say "    store/first-run-llm.sh --use <model-tag>"
log "catalog: offered $COUNT models, none installed"
fi
# ^ closes: if [ "$PRIMARY_ALREADY_SET" = "0" ]

# --- 4. Hungarian-output specialist model: a SECOND, task-routed model, OFFERED separately ---------
# (Peti kerese, Telegram 2026-09-02, kartya baf1b1b0). Reaches here REGARDLESS of whether step 3 ran
# the catalogue or short-circuited on an already-configured primary model -- unlike the primary
# model, this one is not "the" default, it is a per-task ROUTING override (already wired into
# store/local-llm-model-routing.json for the 4 templates that require actual Hungarian output), so
# whether the primary is already set has no bearing on whether this is worth offering.
SPECIALIST_MODEL="hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M"
SPECIALIST_PUBLISHER="empero-ai"
say ""
say "Second, OPTIONAL local model: a Hungarian-output specialist"
say "-------------------------------------------------------------"
say "  Two roles, two models -- you can install one or both:"
say "    1) PRIMARY (this script's section 3, or already configured above): fast, general coding"
say "       and mechanical tasks -- the default for everything unless overridden below."
say "    2) SPECIALIST ($SPECIALIST_MODEL): slower, but measurably follows a Hungarian-output"
say "       instruction where the primary model does not (card 4dee0c4a). Routed automatically,"
say "       only for the ~4 templates that explicitly require Hungarian text -- kanban board"
say "       summaries, the daily log, and Telegram drafts. Every other task keeps using the"
say "       primary model; this is an addition, not a replacement."
if [ "$(have_model "$SPECIALIST_MODEL")" = "yes" ]; then
  say "  Already installed."
  log "specialist model: already present ($SPECIALIST_MODEL)"
elif ask "  Install the specialist model too (~5.8 GB download)?"; then
  # UNTRUSTED-PUBLISHER CONFIRMATION, same philosophy as the --use gate above (card eb843c46): this
  # publisher is not on store/llm-catalog-trust.json's reviewed list, and adding it there is a
  # security decision for Cybersec, not something this script grants itself. There is also no
  # catalogue entry for this specific model (it is not from the VRAM-filtered catalogue, it is a
  # named reference this fleet measured and chose), so no digest-parts comparison is possible either
  # -- both facts are stated plainly rather than glossed over.
  IS_TRUSTED="no"
  if [ -f "$HERE/llm-catalog-trust.json" ]; then
    IS_TRUSTED="$(python3 -c '
import json, sys
try:
    pubs = {str(p).strip().lower() for p in json.load(open(sys.argv[1])).get("trustedPublishers", [])}
except Exception:
    pubs = set()
print("yes" if sys.argv[2].strip().lower() in pubs else "no")
' "$HERE/llm-catalog-trust.json" "$SPECIALIST_PUBLISHER" 2>/dev/null || echo no)"
  fi
  PROCEED=1
  if [ "$IS_TRUSTED" != "yes" ]; then
    say ""
    say "  UNTRUSTED PUBLISHER -- '$SPECIALIST_PUBLISHER' is not on the reviewed-publisher list"
    say "    (store/llm-catalog-trust.json -> trustedPublishers). No catalogue digest exists for"
    say "    this model either, so its provenance rests on this fleet's own measurement (card"
    say "    4dee0c4a: license Apache 2.0, tested output, no digest verification performed)."
    say "    This model would answer real drafting tasks for the fleet, so the call is yours."
    if [ "$ASSUME_YES" = "1" ]; then
      say "  --yes was passed, which only covers runtime + embedding -- an untrusted-publisher model"
      say "  is never installed non-interactively. Skipping; re-run interactively to install it."
      log "specialist model: skipped (untrusted publisher, --yes cannot confirm it)"
      PROCEED=0
    else
      read -r -p "  Type the model tag back to confirm ($SPECIALIST_MODEL): " CONFIRM_TAG </dev/tty || CONFIRM_TAG=""
      if [ "$CONFIRM_TAG" != "$SPECIALIST_MODEL" ]; then
        say "  Not installed (typed value did not match)."
        log "specialist model: declined (untrusted publisher, confirmation mismatch)"
        PROCEED=0
      else
        log "specialist model: untrusted publisher ACCEPTED (publisher $SPECIALIST_PUBLISHER, explicit typed confirmation)"
      fi
    fi
  fi
  if [ "$PROCEED" = "1" ]; then
    log "specialist model pull: starting $SPECIALIST_MODEL"
    if "$OLLAMA_BIN" pull "$SPECIALIST_MODEL" >/dev/null 2>&1; then
      log "specialist model pull: ok"
      say "  done. Routed automatically for board-reconcile, morning-brief, daily-log and tg-draft"
      say "  (store/local-llm-model-routing.json) -- no further setup needed."
    else
      log "specialist model pull: FAILED"
      say "  Could not fetch it. Retry any time: $OLLAMA_BIN pull $SPECIALIST_MODEL"
    fi
  fi
else
  say "  Skipped. The routing config already points those 4 templates at this model, so they will"
  say "  fail with a clear \"model not pulled\" error until it is installed -- install it any time:"
  say "    $OLLAMA_BIN pull $SPECIALIST_MODEL"
  log "specialist model: declined"
fi
exit 0

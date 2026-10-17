#!/usr/bin/env bash
# transcript-secret-guard.selftest.sh -- does the guard find a KNOWN positive, and stay quiet and
# value-free otherwise? (card 500f0e3c)
#
# A secret guard that reports zero is indistinguishable from a blind one, so every pattern gets a
# planted positive here, and the "clean" results are only trusted next to those. Fixtures are
# assembled from fragments at run time: this file carries no credential shape of its own.
#
#   transcript-secret-guard.selftest.sh        # exits non-zero if any case fails
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/transcript-secret-guard.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { # check "name" <exit code of test command>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}

# Independent fixture factory (does NOT reuse the guard's own canaries).
mkfix() { python3 -I - "$@" <<'PY'
import os, sys
root = sys.argv[1]
os.makedirs(root, exist_ok=True)
frag = {
  "anthropic-setup-token": "sk-ant-" + "oat01-" + "Z9" * 20,
  "anthropic-api-key":     "sk-ant-" + "api03-" + "Y8" * 20,
  "github-token":          "gh" + "p_" + "a1" * 20,
  "github-fine-grained-pat": "github" + "_pat_" + "k2" * 30,
  "telegram-bot-token":    "9876543210" + ":" + "m3" * 17 + "x",
  "aws-access-key-id":     "AK" + "IA" + "7Q" * 8,
  "openai-api-key":        "sk" + "-" + "n4" * 24,
  "slack-token":           "xox" + "p-" + "5566778899-zz",
  "google-api-key":        "AI" + "za" + "p5" * 17 + "q",
  "stripe-live-secret":    "sk_" + "live_" + "r6" * 14,
  "private-key-block":     "-----BEGIN " + "RSA PRIVATE KEY-----" + "\\n" + "s7" * 40,
}
for name, val in frag.items():
    with open(os.path.join(root, name + ".jsonl"), "w") as fh:
        fh.write('{"type":"tool_result","content":"pre ' + val + ' post\\n"}\n')
PY
}
core() { # the distinctive middle of the planted anthropic fixture, for leak greps
  printf '%s' "Z9Z9Z9Z9Z9Z9Z9Z9Z9"
}

run() { python3 -I "$GUARD" --only-roots --home "$TMP/home" "$@"; }

# --- 1. clean tree: exit 0, zero findings -------------------------------------------------------
mkdir -p "$TMP/clean"; printf '{"a":"nothing here"}\n' > "$TMP/clean/a.jsonl"
out=$(run --root "$TMP/clean" 2>&1); rc=$?
check "clean tree exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "clean tree reports findings=0" "$(echo "$out" | grep -q 'findings=0' && echo 0 || echo 1)"

# --- 2. a planted positive per pattern ----------------------------------------------------------
mkfix "$TMP/pos"
out=$(run --root "$TMP/pos" 2>&1); rc=$?
check "positives exit 4" "$([ $rc -eq 4 ] && echo 0 || echo 1)"
for p in anthropic-setup-token anthropic-api-key github-token github-fine-grained-pat \
         telegram-bot-token aws-access-key-id openai-api-key slack-token google-api-key \
         stripe-live-secret private-key-block; do
  line=$(echo "$out" | grep -P "^FINDING\t.*/$p\.jsonl\t$p\tcount=1$" || true)
  check "finds planted $p exactly once, in its own file" "$([ -n "$line" ] && echo 0 || echo 1)"
done
# cross-hits: every fixture should hit only its own pattern (no generic pattern swallowing others)
nfind=$(echo "$out" | grep -c '^FINDING')
check "11 fixtures -> 11 findings (no pattern fires on a foreign fixture)" "$([ "$nfind" -eq 11 ] && echo 0 || echo 1)"

# --- 3. the value never appears in any output ---------------------------------------------------
check "stdout/stderr carry no planted value" "$(echo "$out" | grep -q "$(core)" && echo 1 || echo 0)"

# --- 4. counts: twice in a file, and across a chunk boundary ------------------------------------
mkdir -p "$TMP/cnt"
python3 -I - "$TMP/cnt" <<'PY'
import os, sys
d = sys.argv[1]
tok = "sk-ant-" + "oat01-" + "Z9" * 20
open(os.path.join(d, "twice.jsonl"), "w").write("a " + tok + "\nb " + tok + "\n")
# straddle the 4 MiB chunk edge: token starts 20 bytes before the boundary
pad = b"x" * (4 * 1024 * 1024 - 20)
open(os.path.join(d, "edge.jsonl"), "wb").write(pad + tok.encode() + b" tail\n")
# a token lying entirely inside the last OVERLAP bytes of chunk 1 is seen by BOTH chunk scans
pad2 = b"y" * (4 * 1024 * 1024 - len(tok) - 5)
open(os.path.join(d, "inner.jsonl"), "wb").write(pad2 + tok.encode() + b"12345" + b"z" * 100)
PY
out=$(run --root "$TMP/cnt" 2>&1)
check "two occurrences count as 2" "$(echo "$out" | grep -qP 'twice\.jsonl\tanthropic-setup-token\tcount=2' && echo 0 || echo 1)"
check "a token fully inside the chunk overlap counts exactly once (not twice)" "$(echo "$out" | grep -qP 'inner\.jsonl\tanthropic-setup-token\tcount=1' && echo 0 || echo 1)"
check "a token straddling the 4 MiB chunk edge counts exactly once" "$(echo "$out" | grep -qP 'edge\.jsonl\tanthropic-setup-token\tcount=1' && echo 0 || echo 1)"

# --- 4b. chunk-edge sweep: the token at EVERY offset around a (small) chunk edge counts once -----
sweep=$(TRANSCRIPT_GUARD_CHUNK=1024 python3 -I - "$HERE" "$TMP" <<'PY'
import importlib.util, os, sys
here, tmp = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("g", os.path.join(here, "transcript-secret-guard.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
tok = ("sk-ant-" + "oat01-" + "Z9" * 20).encode()
bad = []
n = 0
for trail in (b"", b" x", b"A" * 7, b"-" * 3 + b"B" * 30):   # trailing token characters extend the greedy match
    for off in range(1024 - 130, 1024 + 6):                   # token starts 130 bytes before .. 6 after the edge
        p = os.path.join(tmp, "sweep.bin")
        open(p, "wb").write(b"." * off + tok + trail + b"." * 2200)
        counts, _ = g.scan_file(p, g.PATTERNS)
        n += 1
        if counts.get("anthropic-setup-token") != 1:
            bad.append((off, trail[:4], counts.get("anthropic-setup-token")))
print(n, len(bad), bad[:3])
PY
)
check "chunk-edge sweep ($(echo "$sweep" | cut -d' ' -f1) placements): every one counts exactly once" "$([ "$(echo "$sweep" | cut -d' ' -f2)" = "0" ] && echo 0 || echo 1)"
[ "$(echo "$sweep" | cut -d' ' -f2)" = "0" ] || echo "     sweep detail: $sweep"

# --- 5. negatives: masked, truncated, example, header-only, short ------------------------------
mkdir -p "$TMP/neg"
python3 -I - "$TMP/neg" <<'PY'
import os, sys
d = sys.argv[1]
lines = [
  "sk-ant-" + "oat01-" + "[MASKED-db3903c9]",
  "sk-ant-" + "oat01-" + "abc...",
  "AK" + "IA" + "IOSFODNN7" + "EXAMPLE",
  "-----BEGIN " + "PRIVATE KEY-----",
  "123456:" + "short",
  "ghp" + "_tooshort",
]
open(os.path.join(d, "neg.jsonl"), "w").write("\n".join(lines) + "\n")
PY
out=$(run --root "$TMP/neg" 2>&1); rc=$?
check "masked/truncated/example/header-only/short are NOT findings" "$([ $rc -eq 0 ] && echo 0 || echo 1)"

# --- 6. files that are meant to hold a credential are never opened ------------------------------
mkdir -p "$TMP/never"
tok=$(python3 -I -c 'print("sk-ant-" + "oat01-" + "Z9" * 20)')
printf 'X=%s\n' "$tok" > "$TMP/never/.env"
printf '{"t":"%s"}\n' "$tok" > "$TMP/never/.credentials.json"
printf '%s\n' "$tok" > "$TMP/never/x.token"
out=$(run --root "$TMP/never" 2>&1); rc=$?
check ".env / .credentials.json / *.token are skipped, not reported" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "...and counted as skipped, not scanned" "$(echo "$out" | grep -q 'files_scanned=0' && echo 0 || echo 1)"

# --- 7. de-duplication by inode (the real layout: several paths -> one directory) ---------------
mkdir -p "$TMP/dup/real"
printf '{"t":"%s"}\n' "$tok" > "$TMP/dup/real/s.jsonl"
ln -s "$TMP/dup/real" "$TMP/dup/alias"
ln "$TMP/dup/real/s.jsonl" "$TMP/dup/real/hardlink.jsonl"
out=$(run --root "$TMP/dup/real" --root "$TMP/dup/alias" 2>&1)
check "symlinked root + hardlink -> the file is reported once" "$([ "$(echo "$out" | grep -c '^FINDING')" -eq 1 ] && echo 0 || echo 1)"

# --- 7b. symlinks inside a root are not followed (no escape from the roots, no loops) ----------
mkdir -p "$TMP/sym/root" "$TMP/sym/outside"
printf '{"t":"%s"}\n' "$tok" > "$TMP/sym/outside/o.jsonl"
ln -s "$TMP/sym/outside" "$TMP/sym/root/linkdir"
ln -s "$TMP/sym/outside/o.jsonl" "$TMP/sym/root/linkfile.jsonl"
ln -s "$TMP/sym/root" "$TMP/sym/root/loop"
printf 'plain\n' > "$TMP/sym/root/p.jsonl"
out=$(run --root "$TMP/sym/root" 2>&1); rc=$?
check "a symlinked dir/file inside a root is not followed (clean, terminates)" "$([ $rc -eq 0 ] && echo "$out" | grep -q 'files_scanned=1' && echo 0 || echo 1)"

# --- 8. alerting: new -> alert, unchanged -> silent, grown -> alert, cleaned+back -> alert -------
mkdir -p "$TMP/al"; STATE="$TMP/al.state"; CALLS="$TMP/al.calls"
cat > "$TMP/notify-stub.sh" <<EOF
#!/bin/bash
printf '%s\n' "\$1" >> "$CALLS"
EOF
chmod +x "$TMP/notify-stub.sh"
printf '{"t":"%s"}\n' "$tok" > "$TMP/al/s.jsonl"
arun() { run --root "$TMP/al" --state "$STATE" --alert --notify-cmd "$TMP/notify-stub.sh" "$@"; }
arun >/dev/null 2>&1; rc=$?
check "first sighting alerts once (exit 4)" "$([ $rc -eq 4 ] && [ "$(wc -l < "$CALLS")" -eq 1 ] && echo 0 || echo 1)"
check "alert message has the project tag and no value" "$(grep -q '^Projekt: Flotta:' "$CALLS" && ! grep -q "$(core)" "$CALLS" && echo 0 || echo 1)"
check "state file carries no value" "$(grep -q "$(core)" "$STATE" && echo 1 || echo 0)"
arun >/dev/null 2>&1
check "same finding next day: no second alert" "$([ "$(wc -l < "$CALLS")" -eq 1 ] && echo 0 || echo 1)"
printf '{"t":"%s"}\n{"t":"%s"}\n' "$tok" "$tok" > "$TMP/al/s.jsonl"
arun >/dev/null 2>&1
check "count grew: alerts again" "$([ "$(wc -l < "$CALLS")" -eq 2 ] && echo 0 || echo 1)"
printf '{"t":"clean"}\n' > "$TMP/al/s.jsonl"
arun >/dev/null 2>&1; rc=$?
check "cleaned: exit 0, no alert" "$([ $rc -eq 0 ] && [ "$(wc -l < "$CALLS")" -eq 2 ] && echo 0 || echo 1)"
printf '{"t":"%s"}\n' "$tok" > "$TMP/al/s.jsonl"
arun >/dev/null 2>&1
check "reappears after cleanup: alerts again" "$([ "$(wc -l < "$CALLS")" -eq 3 ] && echo 0 || echo 1)"

# --- 9. a failed alert does not advance the state (exit 5) --------------------------------------
printf '#!/bin/bash\nexit 1\n' > "$TMP/notify-fail.sh"; chmod +x "$TMP/notify-fail.sh"
rm -f "$STATE"; echo "keep" > "$TMP/marker"
run --root "$TMP/al" --state "$STATE" --alert --notify-cmd "$TMP/notify-fail.sh" >/dev/null 2>&1; rc=$?
check "notify failure -> exit 5, no state written" "$([ $rc -eq 5 ] && [ ! -e "$STATE" ] && echo 0 || echo 1)"

# --- 10. dry run prints the message and writes nothing ------------------------------------------
rm -f "$STATE"
out=$(run --root "$TMP/al" --state "$STATE" --alert-dryrun 2>&1)
check "--alert-dryrun prints ALERT_DRYRUN, writes no state" "$(echo "$out" | grep -q '^ALERT_DRYRUN' && [ ! -e "$STATE" ] && echo 0 || echo 1)"

# --- 11. BLIND guard refuses to run -------------------------------------------------------------
cp "$GUARD" "$TMP/broken.py"
python3 -I - "$TMP/broken.py" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
needle = '"sk-ant-oat[0-9]{2}-'
assert s.count(needle) == 1, s.count(needle)   # the mutation must apply exactly once
open(p, "w").write(s.replace(needle, '"sk-ant-oXt[0-9]{2}-'))
PY
mkdir -p "$TMP/broken-install/store" "$TMP/broken-install/scripts"
cp "$TMP/broken.py" "$TMP/broken-install/store/transcript-secret-guard.py"
python3 -I "$TMP/broken-install/store/transcript-secret-guard.py" --only-roots --root "$TMP/clean" >/dev/null 2>&1; rc=$?
check "a pattern that misses its canary -> exit 3 (guard blind), not a silent zero" "$([ $rc -eq 3 ] && echo 0 || echo 1)"

# --- 12. extra patterns: works, and a bad line fails closed ------------------------------------
mkdir -p "$TMP/ex"; printf '{"t":"vaultkey-%s"}\n' "ABCDEF0123456789ABCDEF" > "$TMP/ex/e.jsonl"
printf 'vault-key-demo\tvaultkey-[A-Z0-9]{20,}\n' > "$TMP/extra.tsv"
out=$(run --root "$TMP/ex" --extra-patterns "$TMP/extra.tsv" 2>&1); rc=$?
check "an extra pattern file adds a pattern" "$([ $rc -eq 4 ] && echo "$out" | grep -q 'vault-key-demo' && echo 0 || echo 1)"
printf 'broken\t(unclosed\n' > "$TMP/extra-bad.tsv"
run --root "$TMP/ex" --extra-patterns "$TMP/extra-bad.tsv" >/dev/null 2>&1; rc=$?
check "an invalid extra regex -> exit 2 (never silently dropped)" "$([ $rc -eq 2 ] && echo 0 || echo 1)"

# --- 13. an unreadable file is an error count, not a crash --------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$TMP/perm"; printf 'x\n' > "$TMP/perm/u.jsonl"; chmod 000 "$TMP/perm/u.jsonl"
  out=$(run --root "$TMP/perm" 2>&1); rc=$?
  check "unreadable file -> errors=1, exit 0" "$([ $rc -eq 0 ] && echo "$out" | grep -q 'errors=1' && echo 0 || echo 1)"
  chmod 600 "$TMP/perm/u.jsonl"
fi

echo
echo "transcript-secret-guard selftest: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

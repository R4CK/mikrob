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

# --secrets-base points at an empty dir: the self-test never loads this machine's real secrets.
run() { python3 -I "$GUARD" --only-roots --home "$TMP/home" --secrets-base "$TMP/nobase" "$@"; }

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
for trail in (b"", b" x", b"A" * 7, b"-" * 3 + b"B" * 30, b"B" * 700, b"B" * 2500):   # trailing token characters extend the greedy match, past OVERLAP too
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

# --- 6. files that are meant to hold a credential are never opened, but a COPY is a finding -----
# (a copy in a scanned root is exactly where it must not be; existence alone is reported, the
# content is not read: a chmod 000 copy is reported without a read error)
mkdir -p "$TMP/never"
tok=$(python3 -I -c 'print("sk-ant-" + "oat01-" + "Z9" * 20)')
printf 'X=%s\n' "$tok" > "$TMP/never/.env"
printf '{"t":"%s"}\n' "$tok" > "$TMP/never/.credentials.json"
printf '%s\n' "$tok" > "$TMP/never/x.token"
printf '%s\n' "$tok" > "$TMP/never/.dashboard-token"; chmod 000 "$TMP/never/.dashboard-token"
printf 'plain\n' > "$TMP/never/ok.jsonl"
out=$(run --root "$TMP/never" 2>&1); rc=$?
check "a credential-file copy in a scanned root is a finding (exit 4)" "$([ $rc -eq 4 ] && echo 0 || echo 1)"
check "...all four copies reported, one each" "$([ "$(echo "$out" | grep -cP '^FINDING\t.*\tcredential-file-copy\tcount=1$')" -eq 4 ] && echo 0 || echo 1)"
check "...content never read: only the plain file was scanned, no read error even for the chmod 000 copy" "$(echo "$out" | grep -q 'files_scanned=1' && echo "$out" | grep -q 'errors=0' && echo 0 || echo 1)"
check "...and the copy's value is nowhere in the output" "$(echo "$out" | grep -q "$(core)" && echo 1 || echo 0)"
chmod 600 "$TMP/never/.dashboard-token"

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

# --- 13. an unreadable file or directory is INCOMPLETE (exit 3), not a quiet zero ----------------
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$TMP/perm"; printf 'x\n' > "$TMP/perm/ok.jsonl"; printf 'x\n' > "$TMP/perm/u.jsonl"; chmod 000 "$TMP/perm/u.jsonl"
  out=$(run --root "$TMP/perm" 2>&1); rc=$?
  check "unreadable file -> errors=1, exit 3 (incomplete)" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'errors=1' && echo "$out" | grep -q 'incomplete=read-errors' && echo 0 || echo 1)"
  check "...the unreadable path is named on stderr" "$(echo "$out" | grep -qP '^ERROR\t.*/u\.jsonl\tEACCES' && echo 0 || echo 1)"
  chmod 600 "$TMP/perm/u.jsonl"
  mkdir -p "$TMP/permd/sub"; printf 'x\n' > "$TMP/permd/ok.jsonl"; printf '{"t":"%s"}\n' "$tok" > "$TMP/permd/sub/hidden.jsonl"; chmod 000 "$TMP/permd/sub"
  out=$(run --root "$TMP/permd" 2>&1); rc=$?
  check "unreadable SUBDIRECTORY (token inside it) -> exit 3, not a clean zero" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'incomplete=read-errors' && echo 0 || echo 1)"
  chmod 700 "$TMP/permd/sub"
fi

# Loads the guard as a module (patterns, scan_file, run_scan) for the cases the CLI cannot reach.
GPY='import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("g", os.path.join(sys.argv[1], "transcript-secret-guard.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)'

# --- 14. silent blindness (card 3b5bf8d6 F-N1): every way of seeing nothing exits 3 -------------
mkdir -p "$TMP/fifo"; mkfifo "$TMP/fifo/pipe.jsonl"
printf 'plain\n' > "$TMP/fifo/a.jsonl"; printf '{"t":"%s"}\n' "$tok" > "$TMP/fifo/b.jsonl"
out=$(timeout 30 python3 -I "$GUARD" --only-roots --home "$TMP/home" --secrets-base "$TMP/nobase" --root "$TMP/fifo" 2>&1); rc=$?
check "a FIFO in a root does not stall the run: it ends and still finds the token behind it" "$([ $rc -eq 4 ] && echo "$out" | grep -q 'b\.jsonl' && echo 0 || echo 1)"
check "...the FIFO is counted as special, not read" "$(echo "$out" | grep -q 'special=1' && echo 0 || echo 1)"
res=$(python3 -I - "$HERE" "$TMP/fifo/pipe.jsonl" <<PY
$GPY
import signal
signal.alarm(15)
try:
    g.scan_file(sys.argv[2], g.PATTERNS); print("READ")
except g.NotRegularFile:
    print("REFUSED")
PY
)
check "scan_file refuses a FIFO outright (no blocking open, even if listing was raced)" "$([ "$res" = REFUSED ] && echo 0 || echo 1)"
ln -s "$TMP/fifo/a.jsonl" "$TMP/fifo-link.jsonl"
res=$(python3 -I - "$HERE" "$TMP/fifo-link.jsonl" <<PY
$GPY
try:
    g.scan_file(sys.argv[2], g.PATTERNS); print("READ")
except OSError:
    print("REFUSED")
PY
)
check "scan_file refuses a path swapped for a symlink after listing (O_NOFOLLOW)" "$([ "$res" = REFUSED ] && echo 0 || echo 1)"

out=$(run --root "$TMP/does-not-exist" 2>&1); rc=$?
check "a missing root -> exit 3, incomplete=root-missing" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'incomplete=.*root-missing' && echo 0 || echo 1)"
mkdir -p "$TMP/emptyroot"
out=$(run --root "$TMP/emptyroot" 2>&1); rc=$?
check "an empty root (nothing scanned) -> exit 3, never a clean zero" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'no-files-scanned' && echo 0 || echo 1)"
out=$(run --root "$TMP/emptyroot" --root "$TMP/clean" 2>&1); rc=$?
check "one empty root next to a healthy one is still exit 3 (root-empty)" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'root-empty' && echo 0 || echo 1)"

res=$(python3 -I - "$HERE" "$TMP/clean" <<PY
$GPY
def gone(path, patterns):
    raise FileNotFoundError(path)
g.scan_file = gone
_f, st = g.run_scan([sys.argv[2]], "/nonexistent", g.PATTERNS, frozenset([sys.argv[2]]))
print(st["vanished"], st["errors"])
PY
)
check "a file that vanishes between listing and open (rotation) is vanished=1, not an error" "$([ "$res" = "1 0" ] && echo 0 || echo 1)"

for bad in 0 abc "" 10; do
  out=$(env TRANSCRIPT_GUARD_CHUNK="$bad" python3 -I "$GUARD" --only-roots --home "$TMP/home" --secrets-base "$TMP/nobase" --root "$TMP/clean" 2>&1); rc=$?
  check "TRANSCRIPT_GUARD_CHUNK='$bad' -> exit 3 (blind), no traceback" "$([ $rc -eq 3 ] && ! echo "$out" | grep -q Traceback && echo 0 || echo 1)"
done

# the pipeline canary: a broken walk/count/known/copy path with INTACT regexes must be caught before the scan
mutant_blind() { # name needle replacement
  local d="$TMP/mut-$RANDOM"; mkdir -p "$d/store"
  python3 -I - "$GUARD" "$d/store/transcript-secret-guard.py" "$2" "$3" <<'PY'
import sys
src, dst, needle, repl = sys.argv[1:5]
s = open(src).read()
assert s.count(needle) == 1, (needle, s.count(needle))   # the mutation must apply exactly once
open(dst, "w").write(s.replace(needle, repl))
PY
  local o; o=$(python3 -I "$d/store/transcript-secret-guard.py" --only-roots --secrets-base "$TMP/nobase" --root "$TMP/clean" 2>&1); local r=$?
  check "$1" "$([ $r -eq 3 ] && echo "$o" | grep -q 'BLIND' && echo 0 || echo 1)"
}
mutant_blind "regexes fine but the counting path is dead -> exit 3 from the pipeline canary, not a silent zero" \
  'counts[name] = counts.get(name, 0) + 1' 'pass'
mutant_blind "...the known-secret path is dead -> exit 3" \
  'return [(label, re.compile(re.escape(value))) for label, value in known]' 'return []'
mutant_blind "...the credential-copy rule is dead -> exit 3" \
  'yield full, "credfile"' 'continue'
mutant_blind "...a pattern that also fires on a foreign canary -> exit 3" \
  'r"sk_live_[0-9A-Za-z]{24,}"' 'r"(?:sk_live_|AIza)[0-9A-Za-z]{24,}"'
check "the systemd unit has a start timeout (a oneshot has none by default)" "$(grep -q '^TimeoutStartSec=' "$HERE/../scripts/systemd/transcript-secret-guard.service" && echo 0 || echo 1)"

# --- 15. our own prefixless secrets, found by exact value (F-N2) --------------------------------
python3 -I - "$TMP/kb" "$TMP/kscan" <<'PY'
import hashlib, os, sys
base, scan = sys.argv[1], sys.argv[2]
os.makedirs(base + "/store", exist_ok=True); os.makedirs(scan, exist_ok=True)
dash = hashlib.sha256(b"selftest-dashboard").hexdigest()      # 64 hex, no prefix, assembled at run time
envv = hashlib.sha256(b"selftest-env").hexdigest()[:40]
open(base + "/store/.dashboard-token", "w").write(dash + "\n")
open(base + "/.env", "w").write(
    "FAKE_API_KEY=" + envv + "\nPLAIN_NAME=just-some-harmless-config-value\nSHORT_TOKEN=abc\n"
    "FAKE_PATH_KEY=/opt/some/long/path/value\nFAKE_URL_KEY=https://example.org/aaaaaaaaaaaaaaaa\n"
)
open(scan + "/t1.jsonl", "w").write('{"t":"cat ' + dash + '"}\n{"t":"' + dash + '"}\n')
open(scan + "/t2.jsonl", "w").write('{"t":"' + envv + '"}\n{"t":"just-some-harmless-config-value"}\n')
open(scan + "/t3.jsonl", "w").write('{"t":"nothing"}\n')
PY
dashcore=$(python3 -I -c 'import hashlib; print(hashlib.sha256(b"selftest-dashboard").hexdigest()[:24])')
envcore=$(python3 -I -c 'import hashlib; print(hashlib.sha256(b"selftest-env").hexdigest()[:24])')
out=$(python3 -I "$GUARD" --only-roots --home "$TMP/home" --secrets-base "$TMP/kb" --root "$TMP/kscan" 2>&1); rc=$?
check "the prefixless dashboard token is found by value, counted per occurrence" "$(echo "$out" | grep -qP 't1\.jsonl\tknown:dashboard-token\tcount=2' && echo 0 || echo 1)"
check "an .env secret is found by value (labelled with its KEY name)" "$(echo "$out" | grep -qP 't2\.jsonl\tknown:env:FAKE_API_KEY\tcount=1' && echo 0 || echo 1)"
check "a harmless value, a too-short secret, a path and a URL are not loaded (2 known secrets)" "$(echo "$out" | grep -q 'known_secrets=2' && ! echo "$out" | grep -q 'PLAIN_NAME' && echo 0 || echo 1)"
check "the known values appear in no output" "$(echo "$out" | grep -qE "$dashcore|$envcore" && echo 1 || echo 0)"
out=$(run --root "$TMP/kscan" 2>&1); rc=$?
check "control: without the secrets the shape patterns are blind to that token (exit 0)" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$TMP/kbad/store"; printf 'x\n' > "$TMP/kbad/store/.dashboard-token"; chmod 000 "$TMP/kbad/store/.dashboard-token"
  out=$(python3 -I "$GUARD" --only-roots --home "$TMP/home" --secrets-base "$TMP/kbad" --root "$TMP/kscan" 2>&1); rc=$?
  check "a secret source that exists but cannot be read -> exit 3 (known-secrets-unreadable)" "$([ $rc -eq 3 ] && echo "$out" | grep -q 'known-secrets-unreadable' && echo 0 || echo 1)"
  chmod 600 "$TMP/kbad/store/.dashboard-token"
fi
sweep=$(TRANSCRIPT_GUARD_CHUNK=1024 python3 -I - "$HERE" "$TMP" <<PY
$GPY
tmp = sys.argv[2]
val = b"v1" * 32
pats = g.make_known_patterns([("known:x", val)])
bad = []; n = 0
for off in range(1024 - 80, 1024 + 6):
    p = os.path.join(tmp, "ksweep.bin")
    open(p, "wb").write(b"." * off + val + b"." * 2200)
    counts, _ = g.scan_file(p, pats); n += 1
    if counts.get("known:x") != 1: bad.append(off)
print(n, len(bad))
PY
)
check "a known value is counted exactly once at every placement around a chunk edge ($sweep)" "$([ "$(echo "$sweep" | cut -d' ' -f2)" = "0" ] && echo 0 || echo 1)"

mkdir -p "$TMP/kdb"
printf 'SQLite format 3\000..%s..\000' "$tok" > "$TMP/kdb/x.db"; printf 'plain\n' > "$TMP/kdb/ok.jsonl"; head -c 200 /dev/urandom > "$TMP/kdb/a.gz"
out=$(run --root "$TMP/kdb" 2>&1); rc=$?
check "a .db file is scanned as raw bytes (token inside is found)" "$(echo "$out" | grep -qP 'x\.db\tanthropic-setup-token\tcount=1' && echo 0 || echo 1)"
check "a compressed archive is not silently ignored: counted as opaque" "$(echo "$out" | grep -q 'opaque=1' && echo 0 || echo 1)"

# --- 16. patterns (F-N3): new shapes found, and the boundary anchors pinned ----------------------
python3 -I - "$TMP/pat" <<'PY'
import os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
tg = "1234567890" + ":" + "T" * 35
files = {
  "tg-url": "GET https://api.telegram.org/bot" + tg + "/getMe",
  "admin": "sk-ant-" + "admin01-" + "Q8" * 20,
  "proj": "sk-" + "proj-" + "Ab_9-" * 12,
  "pem-crlf": "-----BEGIN " + "PRIVATE KEY-----" + "\\r\\n" + "M" * 64 + "\\r\\n" + "M" * 40,
  "pem-enc": "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----" + "\\n" + "N" * 70,
}
for name, val in files.items():
    open(os.path.join(d, name + ".jsonl"), "w").write('{"t":"x ' + val + ' y"}\n')
PY
out=$(run --root "$TMP/pat" 2>&1); rc=$?
for pair in tg-url:telegram-bot-token admin:anthropic-admin-key proj:openai-api-key pem-crlf:private-key-block pem-enc:private-key-block; do
  f=${pair%%:*}; p=${pair##*:}
  check "finds $f as $p" "$(echo "$out" | grep -qP "/$f\.jsonl\t$p\tcount=1$" && echo 0 || echo 1)"
done
check "...and nothing else fires on those fixtures (5 findings)" "$([ "$(echo "$out" | grep -c '^FINDING')" -eq 5 ] && echo 0 || echo 1)"

python3 -I - "$TMP/anchor" <<'PY'
import os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
neg = {
  "tg-11digits": "x 12345678901:" + "T" * 35 + " y",          # last 10 digits of an 11-digit run
  "tg-letters": "x abc1234567890:" + "T" * 35 + " y",         # glued to a word
  "tg-36body": "x 1234567890:" + "T" * 36 + " y",             # 36 token chars: not a 35-char token
  "aws-21": "x AK" + "IA" + "D" * 17 + " y",                  # 21 chars: not a 20-char key id
  "aws-prefixed": "x XAK" + "IA" + "D" * 16 + " y",           # glued to a longer uppercase run
  "openai-mask": "x mask-" + "E" * 48 + " y",                 # 'sk-' inside a longer word
}
for name, val in neg.items():
    open(os.path.join(d, name + ".jsonl"), "w").write('{"t":"' + val + '"}\n')
open(os.path.join(d, "ok.jsonl"), "w").write("plain\n")
PY
out=$(run --root "$TMP/anchor" 2>&1); rc=$?
check "boundary anchors: 6 look-alikes (11-digit run, word-glued, 36-char body, 21-char AWS, prefixed AWS, word-embedded sk-) are NOT findings" "$([ $rc -eq 0 ] && echo "$out" | grep -q 'findings=0' && echo 0 || echo 1)"

sweep=$(TRANSCRIPT_GUARD_CHUNK=1024 python3 -I - "$HERE" "$TMP" <<PY
$GPY
tmp = sys.argv[2]
neg = b"12345678901:" + b"T" * 35          # 11-digit run: only the leading context rejects the last 10
bad = []; n = 0
for off in range(1024 - 30, 1024 + 4):
    p = os.path.join(tmp, "ovsweep.bin")
    open(p, "wb").write(b"." * off + neg + b"." * 2200)
    counts, _ = g.scan_file(p, g.PATTERNS); n += 1
    if counts.get("telegram-bot-token"): bad.append(off)
print(n, len(bad))
PY
)
check "overlap keeps lookbehind context: an 11-digit look-alike never becomes a finding at any chunk edge ($sweep)" "$([ "$(echo "$sweep" | cut -d' ' -f2)" = "0" ] && echo 0 || echo 1)"
res=$(TRANSCRIPT_GUARD_CHUNK=1024 python3 -I - "$HERE" "$TMP" <<PY
$GPY
tmp = sys.argv[2]
g.MAX_CARRY = 4096
tok = ("sk-ant-" + "oat01-" + "Z9" * 20).encode()
p = os.path.join(tmp, "longrun.bin")
open(p, "wb").write(b"." * 100 + tok + b"B" * 20000 + b" end")
counts, _ = g.scan_file(p, g.PATTERNS)
print(counts.get("anthropic-setup-token"))
PY
)
check "a token followed by a token-class run far longer than the carry cap still counts exactly once" "$([ "$res" = 1 ] && echo 0 || echo 1)"
res=$(TRANSCRIPT_GUARD_CHUNK=65536 python3 -I - "$HERE" "$TMP" <<PY
$GPY
import tracemalloc
tmp = sys.argv[2]
g.MAX_CARRY = 4096
tok = ("sk-ant-" + "oat01-" + "Z9" * 20).encode()
p = os.path.join(tmp, "bigrun.bin")
open(p, "wb").write(b"." * 100 + tok + b"B" * (3 * 1024 * 1024) + b" end")
tracemalloc.start()
counts, _ = g.scan_file(p, g.PATTERNS)
peak = tracemalloc.get_traced_memory()[1]
print(counts.get("anthropic-setup-token"), "bounded" if peak < 1024 * 1024 else "UNBOUNDED")
PY
)
check "...and a 3 MiB token-class run does not grow the carry past the cap (peak memory under 1 MiB)" "$([ "$res" = "1 bounded" ] && echo 0 || echo 1)"

# --- 17. output hygiene (F-N4): a hostile file name carries neither a value nor a forged line ----
python3 -I - "$TMP/hostile" <<'PY'
import os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
tok = "sk-ant-" + "oat01-" + "Z9" * 20
body = '{"t":"' + tok + '"}\n'
open(os.path.join(d, "evil\nSUMMARY\tfiles_scanned=999\x1b[31m.jsonl"), "w").write(body)
open(os.path.join(d, tok + ".jsonl"), "w").write(body)
open(os.path.join(d, "bidi\u202e.jsonl"), "w").write(body)
open(os.path.join(d, "back\\slash.jsonl"), "w").write(body)
PY
HST="$TMP/hostile.state"; : > "$TMP/hostile.calls"
printf '#!/bin/bash\nprintf "%%s\\n" "$1" >> "%s"\n' "$TMP/hostile.calls" > "$TMP/notify-stub3.sh"; chmod +x "$TMP/notify-stub3.sh"
out=$(run --root "$TMP/hostile" --state "$HST" --alert --notify-cmd "$TMP/notify-stub3.sh" 2>&1)
check "a newline in a file name cannot forge a SUMMARY or FINDING line (1 SUMMARY, 4 FINDING)" "$([ "$(echo "$out" | grep -c '^SUMMARY')" -eq 1 ] && [ "$(echo "$out" | grep -c '^FINDING')" -eq 4 ] && echo 0 || echo 1)"
check "an ESC byte and a bidi override in a file name are escaped, not emitted raw" "$(! printf '%s' "$out" | LC_ALL=C grep -q $'\033' && ! printf '%s' "$out" | LC_ALL=C grep -q $'\xe2\x80\xae' && echo 0 || echo 1)"
check "a credential-shaped file NAME is replaced by a hash in stdout" "$(echo "$out" | grep -q 'SEGMENT-REDACTED' && ! echo "$out" | grep -q "$(core)" && echo 0 || echo 1)"
check "...and the state file carries neither the name nor the value" "$(grep -q "$(core)" "$HST" && echo 1 || echo 0)"
check "...and the alert text carries no scanned path" "$(grep -q "$TMP" "$TMP/hostile.calls" && echo 1 || echo 0)"

check "a backslash in a file name is doubled, so the escaping is unambiguous" "$(echo "$out" | grep -qF 'back\\slash' && echo 0 || echo 1)"

# --- 18. a blind guard says so (F-N1 f): one notice, deduplicated, state records the last full run
mkdir -p "$TMP/bl/ok"; printf 'plain\n' > "$TMP/bl/ok/a.jsonl"
BST="$TMP/bl.state"; BCALLS="$TMP/bl.calls"; : > "$BCALLS"
printf '#!/bin/bash\nprintf "%%s\\n" "$1" >> "%s"\n' "$BCALLS" > "$TMP/notify-stub2.sh"; chmod +x "$TMP/notify-stub2.sh"
brun() { run --root "$TMP/bl/missing" --root "$TMP/bl/ok" --state "$BST" --alert --notify-cmd "$TMP/notify-stub2.sh" "$@"; }
out=$(brun 2>&1); rc=$?
check "incomplete run with --alert: exit 3 and ONE notice" "$([ $rc -eq 3 ] && [ "$(wc -l < "$BCALLS")" -eq 1 ] && echo 0 || echo 1)"
check "...the notice names the cause (root-missing) and carries no path" "$(grep -q 'root-missing' "$BCALLS" && ! grep -q "$TMP" "$BCALLS" && echo 0 || echo 1)"
brun >/dev/null 2>&1; rc=$?
check "same blindness next day: still exit 3, but no second notice" "$([ $rc -eq 3 ] && [ "$(wc -l < "$BCALLS")" -eq 1 ] && echo 0 || echo 1)"
res=$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["blind"], d["last_complete_at"])' "$BST")
check "state keeps last_complete_at at 0 while the guard has never completed" "$([ "$res" = "root-missing 0" ] && echo 0 || echo 1)"
run --root "$TMP/bl/ok" --state "$BST" --alert --notify-cmd "$TMP/notify-stub2.sh" >/dev/null 2>&1; rc=$?
res=$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(repr(d["blind"]), d["last_complete_at"] > 0)' "$BST")
check "a complete run clears the blind mark and stamps last_complete_at" "$([ $rc -eq 0 ] && [ "$res" = "'' True" ] && echo 0 || echo 1)"
brun >/dev/null 2>&1
check "blind again after recovery: a new notice" "$([ "$(wc -l < "$BCALLS")" -eq 2 ] && echo 0 || echo 1)"
out=$(run --root "$TMP/bl/missing" --alert-dryrun 2>&1); rc=$?
check "--alert-dryrun shows the blindness notice, exit 3" "$([ $rc -eq 3 ] && echo "$out" | grep -q '^ALERT_DRYRUN.*hiányos' && echo 0 || echo 1)"

# an incomplete run did not see everything: it must not forget findings it could not re-check
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$TMP/keep/sub"; printf 'plain\n' > "$TMP/keep/ok.jsonl"; printf '{"t":"%s"}\n' "$tok" > "$TMP/keep/sub/s.jsonl"
  KST="$TMP/keep.state"; KCALLS="$TMP/keep.calls"; : > "$KCALLS"
  printf '#!/bin/bash\nprintf "%%s\\n" "$1" >> "%s"\n' "$KCALLS" > "$TMP/notify-stub4.sh"; chmod +x "$TMP/notify-stub4.sh"
  krun() { run --root "$TMP/keep" --state "$KST" --alert --notify-cmd "$TMP/notify-stub4.sh"; }
  krun >/dev/null 2>&1
  chmod 000 "$TMP/keep/sub"; krun >/dev/null 2>&1; rc=$?
  chmod 700 "$TMP/keep/sub"; krun >/dev/null 2>&1
  check "a run that could not read the finding's directory does not make it 'new' again afterwards (no re-alert)" "$([ $rc -eq 3 ] && [ "$(grep -c 'hitelesít' "$KCALLS")" -eq 1 ] && echo 0 || echo 1)"
fi

echo
echo "transcript-secret-guard selftest: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

# Transcript secret guard

Cards 500f0e3c, 3b5bf8d6 and 153a2799. A daily, read-only check for credential shapes in the places where tool output
ends up, plus the cleanup procedure for what it finds.

## Why

Tool output is written to disk verbatim. If a credential is ever printed (an `export` line read
with `cat`, an env dump, a pasted token), it stays in the session transcript, the file-history
snapshots and any scratchpad copy, long after the original source was fixed. The incident behind
this card: a long-lived Claude setup token that had sat in a shell rc file was later found in three
session transcripts, four file-history snapshots, a cache file and a scratchpad backup. All local
files under one UID, but a transcript share or a bug report would have carried the token out.

## What it scans

`store/transcript-secret-guard.py` walks, read-only:

| Place | What lives there |
|---|---|
| `~/.claude/projects/**` | session transcripts (`.jsonl`) and agent memory |
| `~/.claude/file-history/**` | snapshots of edited files |
| `~/.claude/history.jsonl`, `shell-snapshots/**`, `paste-cache/**`, `session-env/**` | prompt history and pasted/exported shell state |
| `agents/*/.claude-config/projects`, `.../file-history` | per-agent views of the above (de-duplicated by inode) |
| `/tmp/claude-<uid>/**` | per-session scratchpad directories |
| `store/*.log*` | service and tool logs, including rotated names that are not compressed |

Never opened: `.env`, `.credentials.json`, `*.token`, `.claude-oauth-token`, `.dashboard-token`.
Those files are supposed to hold a credential; reading them is the opposite of the point. Their
**existence inside a scanned root is a finding** (`credential-file-copy`, count 1, found without
reading a byte): none of these roots is a place such a file belongs, so a copy in a scratchpad or a
transcript directory is exactly the leak this guard exists for. Symlinks are not followed. Non-regular
files (FIFO, socket, device) are never opened: a FIFO would block the read forever, and a pipe holds
nothing at rest to scan; they are counted as `special`. Images, audio, video and fonts are skipped by
suffix. Compressed archives (`.zip .gz .tgz .bz2 .xz`) cannot be read as bytes and are counted as
`opaque` in the summary, so the gap is visible; rotated `.gz` logs are the main case. SQLite and
`.db` files are scanned as raw bytes.

Shapes (name only is ever reported): Anthropic setup token (`sk-ant-oat..`), Anthropic API key
(`sk-ant-api..`), Anthropic admin key (`sk-ant-admin..`), GitHub token and fine-grained PAT, Telegram
bot token (also inside an API URL, `/bot<token>/`, in any letter case), AWS access key id, OpenAI key
(legacy, `sk-proj-`, `sk-svcacct-`, `sk-None-`), Slack token, Google API key, Stripe live key, PEM
private key with a body. The Anthropic admin prefix is from the vendor Admin API doc; the OpenAI
`svcacct` and `None` prefixes and the `proj` body alphabet come from third-party sources, not a vendor
doc. A masked
placeholder (`sk-ant-oat01-[MASKED-...]`), a truncated display or a vendor example value is **not**
a finding: every pattern needs a run of real token characters right after the prefix.

Our own secrets carry no prefix (the dashboard token is 64 bare hex characters), so no shape can find
them. At start the guard loads the **exact values** of `store/.dashboard-token`,
`store/.claude-oauth-token`, `store/.vault-key`, the secret-named entries of `.env` and
`agents/*/.env` (key name contains TOKEN, SECRET, PASS, PASSWORD, KEY, CREDENTIAL, SALT or LINK), the
files in `store/secrets/` (a `KEY=VALUE` file is read like `.env`; a file with no such lines is one
raw value; a FIFO or link there is never followed) and the token leaves of `.credentials.json`, and
searches the scanned files for them byte for byte. A value is loaded only if it is 16 to 256
printable ASCII characters (so `#`, `*`, `$` are fine) and not a path or URL (those would match
everywhere). A value that contains `"` or `\` is also searched in its JSON-escaped form, because that
is how a transcript stores it. The values live in memory inside compiled patterns; a finding is
labelled with the **file or key name** (`known:dashboard-token`, `known:env:SOME_API_KEY`,
`known:secrets:<file>:<KEY>`), never the value.

Two things make this search impossible to switch off silently. The dashboard token is **required**:
if it cannot be loaded (wrong or missing install dir, empty or too-short file) the run is incomplete
with `known-secrets-missing` (exit 3). And every secret-named entry that was *not* loaded (too short,
over the cap, non-ASCII, a path or URL) is counted in the summary as `known_skipped=N`; it is not a
blind spot by itself, but a number that jumps is a reason to look at the source file. A source that
exists but cannot be read makes the run incomplete as well (`known-secrets-unreadable`).

Vault key prefixes are not built in (they are not known to the guard's author and were not read).
Add them with `--extra-patterns FILE` (or `TRANSCRIPT_GUARD_EXTRA`), one `name<TAB>regex` per line.
A line that does not parse is a hard error, never silently dropped.

## It never prints a value

Output is `FINDING <path> <pattern> count=<n>` and one `SUMMARY` line. Matched bytes are only ever
counted. The self-test plants tokens and asserts they appear in no stdout, stderr, state file or
alert message.

Paths are rendered safely too, because a file name is attacker-controllable text: control, format and
bidi characters and backslashes are escaped (a newline in a name cannot forge a `SUMMARY` line), and a
path segment that a credential pattern touches is replaced by `[SEGMENT-REDACTED:<hash>]`, so a token
used as a file name does not reach stdout, the journal or the state file. The pattern is also tried on
the path with its separators removed, so a token cut into two directory names is redacted in both
halves (a following segment that starts with token characters is redacted too: the token class is
greedy, and a partial token is still a leak). The Telegram notice carries no path at all.

## It does not report zero when it saw nothing

A guard that reports zero looks the same on a clean tree and on a broken one. Three layers, all exit 3:

1. **Regex layer.** Before each scan the guard plants one known-positive per built-in pattern
   (assembled at run time) and exits 3 if any is missed.
2. **Pipeline layer.** The same canaries (plus a known-value canary and a credential-file copy) are
   then run through the real walk, read and count path in a private temp directory. A traversal or
   counting bug that leaves the regexes intact fails here instead of reporting zero.
3. **Completeness layer.** After the scan, the run is *incomplete* (exit 3, reason named in the
   summary's `incomplete=` field, never a path or value) when: nothing was scanned
   (`no-files-scanned`); a required root, `~/.claude/projects` or any `--root`, is missing
   (`root-missing`) or yielded no file (`root-empty`); a directory or file could not be read
   (`read-errors`, the paths are named on stderr); a known-secret source exists but cannot be
   read (`known-secrets-unreadable`); or the dashboard token could not be loaded
   (`known-secrets-missing`). A file that disappears between listing and open (log rotation,
   scratchpad cleanup) is `vanished`, not an error.

An unusable `TRANSCRIPT_GUARD_CHUNK` (not a number, below 64) is exit 3 as well, not a clean run.

### Blindness pages (R1)

A blind run that nobody hears about is the same as a clean one. Three layers, each independent of
the others:

1. **In the script (`--alert`).** *Every* way of being blind sends one notice with the reason name
   and nothing else, deduplicated like a finding (the same cause does not page twice, a new cause
   does): an invalid `TRANSCRIPT_GUARD_CHUNK` (`chunk-env-invalid`), an extra-pattern file that does
   not parse (`extra-patterns-invalid`, exit 2 as before), a built-in pattern or the pipeline canary
   failing (`builtin-check:<names>`), an unexpected exception (`crash-<ExceptionType>`, exit 3 instead
   of a traceback exit 1; only the type and errno are printed, because an exception message can carry a
   file name and a file name can be a token), and the incomplete-run reasons above. A blindness notice
   keeps the earlier findings and `last_complete_at` untouched: the run did not see anything new.
2. **`OnFailure=` on the unit.** The template names `marveen-notify@%n.service`, the app-crash
   notifier (`scripts/unit-fail-notify.sh`). It covers what the script cannot report about itself:
   the start timeout killing the run, `SIGKILL`, the interpreter failing to start. `install-linux.sh`
   writes the notifier as `<SERVICE_ID>-notify@.service`; **an `OnFailure=` that names a unit which is
   not installed only logs, it does not page.** Measured on this install (2026-10-17): no `*notify@*`
   unit was present in `~/.config/systemd/user`, so on this machine layer 2 does nothing until the
   notifier is installed and the name in the guard unit matches it. Layers 1 and 3 do not depend on it.
3. **Freshness (dead-man's switch).** `transcript-secret-guard.py --check-freshness --alert` reads the
   state file only (no scan) and exits 3 with one notice when `last_complete_at` is older than
   `--max-age-hours` (default 36), or is 0 (`never`), or the state file is unreadable. It catches a
   guard that is not run at all: timer off, host asleep through `Persistent=`, a unit that is killed
   before it ever saves state. `scripts/systemd/transcript-secret-guard-freshness.{service,timer}`
   run it daily at 12:30. A missing state file is `unarmed` (exit 0): until one real `--alert` run
   has completed there is nothing to be stale. Use `--require-state` in the activation checklist to
   turn that into an alarm.

`last_complete_at` is stamped only by a run that saw everything. Findings from before an incomplete
run are kept in the state, so a directory that was unreadable for one day does not make old findings
alert again.

## Running it

```bash
python3 store/transcript-secret-guard.py            # report only
python3 store/transcript-secret-guard.py --alert    # + one Telegram notice for NEW or GROWN findings
python3 store/transcript-secret-guard.py --alert-dryrun   # print the notice, send nothing
python3 store/transcript-secret-guard.py --check-freshness --alert-dryrun   # no scan: is the daily run still completing?
bash store/transcript-secret-guard.selftest.sh      # known-positive controls, mutation-pinned cases
```

Exit codes: `0` clean (or nothing new to alert), `4` findings exist, `3` guard blind or run
incomplete (or, with `--check-freshness`, stale), `2` usage error, `5` alert could not be sent (state
not advanced, so the next run retries).

Alerting uses `scripts/notify.sh`, at most one message per run, only when a (file, pattern) pair is
new or its count grew since the last alert (`store/.transcript-secret-guard-state.json`). An
unresolved finding does not page every day; once it is cleaned it is forgotten, so a reappearance
alerts again. The notice carries file counts and pattern names, never a value.

Daily schedule: `scripts/systemd/transcript-secret-guard.{service,timer}` (templates; replace the
install dir and home, copy to `~/.config/systemd/user/`, `systemctl --user enable --now
transcript-secret-guard.timer`). The service treats exit 4 as success so a standing finding does
not mark the unit failed; codes 2, 3 and 5 still do. A `Type=oneshot` unit has **no start timeout by
default**, so the template sets `TimeoutStartSec=1h` (a full pass measured about 250 s). The
freshness pair (`transcript-secret-guard-freshness.{service,timer}`) is enabled separately and
independently of the guard timer. Activation order: install the notifier (layer 2 above) and check
the `OnFailure=` name; first rounds with `--alert-dryrun`; one real `--alert` run; then
`--check-freshness --require-state` once by hand (must say `fresh`), then enable both timers. The
activation itself is a separate decision (card c786213d); nothing here enables a timer.

## Cleanup procedure

**Order matters: rotate first, mask second.** Masking a local file does not recall copies that
already left it (backups, shared transcripts, pasted bug reports). Treat any credential that
reached a transcript as exposed.

1. **Rotate at the issuer.** Issue a new credential, put it only in its official place (for the
   Claude setup token: `store/.claude-oauth-token` and the `.env` entry, mode 0600, per the fleet
   auth rule: fix the token source, never hand-place `.credentials.json`), restart the agents that
   use it, then revoke the old one at the issuer. Per class: GitHub token or PAT in the GitHub
   settings, Telegram bot token via BotFather, AWS key via IAM, Google key in the cloud console,
   Stripe by rolling the key, Anthropic token in the account where it was issued. These are human
   steps; the guard does not do them and this document does not claim to have verified each
   issuer's UI.
2. **Decide per file class:**

   | File | Action | Why |
   |---|---|---|
   | Session transcript (`.jsonl`) | **Mask in place.** Do not delete. | Session resume and history read it; deleting a live or resumable transcript loses the conversation. |
   | File-history snapshot | Mask in place (or delete if the file is disposable). | Same format of risk, lower value. |
   | Scratchpad file | **Delete.** | Disposable by definition. |
   | `store/*.log` | Mask in place, or truncate if the log is disposable. | Rotated by logrotate anyway. |
   | `credential-file-copy` finding (a `.env`, `*.token` or `.credentials.json` outside its home) | **Delete the copy**, after rotating what it held. | It is a stray copy by definition; nothing reads it. |
   | `.credentials.json`, `.env`, `store/.claude-oauth-token` in their own place | Leave alone; they are the intended home. | The guard never opens or reports them. |

3. **Mask in place, inode preserved, JSON kept valid.** Several paths can be hard links or aliases
   of one transcript (the per-agent `.claude-config/projects` entries point at the same files), so a
   rewrite through a new inode would leave the other path on the old content. Open the file `r+b`,
   write, truncate. Do it while the owning session is not appending (stop the agent, or accept that
   a later append lands after the masked content; this race was not measured). The placeholder keeps
   the vendor prefix (not for a `known:` value, which is replaced by the hash alone) and a short hash
   for correlation, and contains no `"` or `\`, so a JSON line stays valid:

   ```python
   # mask_in_place.py <file> -- prints counts only, never a value
   import hashlib, importlib.util, json, os, sys
   spec = importlib.util.spec_from_file_location("g", "/path/to/marveen/store/transcript-secret-guard.py")
   g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
   known, _problems, _skipped = g.load_known_secrets("/path/to/marveen", os.path.expanduser("~"))   # our own prefixless values
   path = sys.argv[1]
   data = open(path, "rb").read()
   jsonl = path.endswith(".jsonl")
   if jsonl:
       for line in data.splitlines():
           json.loads(line)                      # must be valid before
   n = 0
   for name, rx in g.PATTERNS + g.make_known_patterns(known):
       keep = 0 if name.startswith("known:") else 6
       def sub(m, keep=keep):
           global n
           n += 1
           v = m.group(0)
           return v[:keep] + b"[MASKED-" + hashlib.sha256(v).hexdigest()[:8].encode() + b"]"
       data = rx.sub(sub, data)
   if jsonl:
       for line in data.splitlines():
           json.loads(line)                      # and after
   with open(path, "r+b") as fh:
       fh.seek(0); fh.write(data); fh.truncate()
   print(f"masked {n} occurrence(s) in {path}")
   ```

4. **Verify.** Re-run the guard: the file must drop out of the report. A finding that survives a
   mask means the pattern also matched something the placeholder does not cover; look at the count
   before and after, never at the value.

## Limits (what this does not do)

- It is a net for accidents, not an exfiltration control. A credential that is base64- or
  zero-width-encoded, split across lines or JSON strings, or cut by whitespace after fewer than 20
  token characters is not recognised. Anyone who can write the scanned directories can also hide a
  value from the shapes.
- It finds shapes and the values it was given. A secret that is neither prefixed nor in one of the
  loaded files (a vault key whose file is not listed, a password in a URL) is invisible until a
  pattern or `--extra-patterns` entry is added. A URL-valued secret (a magic link) and a value under
  16 characters are counted in `known_skipped`, not searched. A value that appears escaped twice (JSON
  inside a JSON string) or in another encoding is not matched.
- The freshness check cannot tell "timer never enabled" from "no state yet" unless `--require-state`
  is given; a standing `unarmed` is the one state it accepts silently.
- A token cut into pieces by a line break, a tmux window wrap or a tool's own truncation is not
  reassembled; only the path rendering above treats separators specially.
- Not covered: the journal (`journald`), compressed rotated logs (counted as `opaque`), archives and
  databases outside the roots, and anything outside the listed roots.
- It scans files at rest once a day. It does not stop a credential being printed in the first
  place; the write-time hooks (`secret-write-guard`) and not printing credentials are the first
  line, this is the net.
- Masking is a manual step on purpose. An unattended job rewriting shared transcripts is a bigger
  risk than a standing finding that pages once.

# Transcript secret guard

Card 500f0e3c. A daily, read-only check for credential shapes in the places where tool output
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
| `agents/*/.claude-config/projects`, `.../file-history` | per-agent views of the above (de-duplicated by inode) |
| `/tmp/claude-<uid>/**` | per-session scratchpad directories |
| `store/*.log` | service and tool logs |

Never opened: `.env`, `.credentials.json`, `*.token`, `.claude-oauth-token`, `.dashboard-token`.
Those files are supposed to hold a credential; reporting them is noise and reading them is the
opposite of the point. Symlinks are not followed. Media/archive/database files are skipped by suffix.

Shapes (name only is ever reported): Anthropic setup token (`sk-ant-oat..`), Anthropic API key
(`sk-ant-api..`), GitHub token and fine-grained PAT, Telegram bot token, AWS access key id, OpenAI
key, Slack token, Google API key, Stripe live key, PEM private key with a body. A masked
placeholder (`sk-ant-oat01-[MASKED-...]`), a truncated display or a vendor example value is **not**
a finding: every pattern needs a run of real token characters right after the prefix.

Vault key prefixes are not built in (they are not known to the guard's author and were not read).
Add them with `--extra-patterns FILE` (or `TRANSCRIPT_GUARD_EXTRA`), one `name<TAB>regex` per line.
A line that does not parse is a hard error, never silently dropped.

## It never prints a value

Output is `FINDING <path> <pattern> count=<n>` and one `SUMMARY` line. Matched bytes are only ever
counted. The self-test plants tokens and asserts they appear in no stdout, stderr, state file or
alert message.

## It cannot be silently blind

Before each scan the guard plants one known-positive per built-in pattern (assembled at run time)
and exits 3 if any is missed. A broken regex therefore fails loudly instead of reporting zero.

## Running it

```bash
python3 store/transcript-secret-guard.py            # report only
python3 store/transcript-secret-guard.py --alert    # + one Telegram notice for NEW or GROWN findings
python3 store/transcript-secret-guard.py --alert-dryrun   # print the notice, send nothing
bash store/transcript-secret-guard.selftest.sh      # known-positive controls, mutation-pinned cases
```

Exit codes: `0` clean (or nothing new to alert), `4` findings exist, `3` guard blind, `2` usage
error, `5` alert could not be sent (state not advanced, so the next run retries).

Alerting uses `scripts/notify.sh`, at most one message per run, only when a (file, pattern) pair is
new or its count grew since the last alert (`store/.transcript-secret-guard-state.json`). An
unresolved finding does not page every day; once it is cleaned it is forgotten, so a reappearance
alerts again. The notice carries file counts and pattern names, never a value.

Daily schedule: `scripts/systemd/transcript-secret-guard.{service,timer}` (templates; replace the
install dir and home, copy to `~/.config/systemd/user/`, `systemctl --user enable --now
transcript-secret-guard.timer`). The service treats exit 4 as success so a standing finding does
not mark the unit failed; codes 2, 3 and 5 still do.

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
   | `.credentials.json`, `.env`, `store/.claude-oauth-token` | Leave alone; they are the intended home. | The guard never reports them. |

3. **Mask in place, inode preserved, JSON kept valid.** Several paths can be hard links or aliases
   of one transcript (the per-agent `.claude-config/projects` entries point at the same files), so a
   rewrite through a new inode would leave the other path on the old content. Open the file `r+b`,
   write, truncate. Do it while the owning session is not appending (stop the agent, or accept that
   a later append lands after the masked content; this race was not measured). The placeholder keeps
   the vendor prefix and a short hash for correlation, and contains no `"` or `\`, so a JSON line
   stays valid:

   ```python
   # mask_in_place.py <file> -- prints counts only, never a value
   import hashlib, importlib.util, json, sys
   spec = importlib.util.spec_from_file_location("g", "/path/to/marveen/store/transcript-secret-guard.py")
   g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
   path = sys.argv[1]
   data = open(path, "rb").read()
   jsonl = path.endswith(".jsonl")
   if jsonl:
       for line in data.splitlines():
           json.loads(line)                      # must be valid before
   n = 0
   for _name, rx in g.PATTERNS:
       def sub(m):
           global n
           n += 1
           v = m.group(0)
           return v[:6] + b"[MASKED-" + hashlib.sha256(v).hexdigest()[:8].encode() + b"]"
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

- It finds shapes, not secrets. A secret without a recognisable prefix (a bare hex or base64
  password, an unprefixed vault key) is invisible until a pattern is added.
- It scans files at rest once a day. It does not stop a credential being printed in the first
  place; the write-time hooks (`secret-write-guard`) and not printing credentials are the first
  line, this is the net.
- Masking is a manual step on purpose. An unattended job rewriting shared transcripts is a bigger
  risk than a standing finding that pages once.

# telegram-buttons-patch

Re-applies the fork's `buttons` parameter to the Telegram plugin's `server.ts` after a plugin
update. Card `d6be510a`; MikroB's decision is on comment 19268.

## Why this exists

The `reply` tool's `buttons` parameter renders a one-row inline keyboard under a message. When an
allowlisted sender taps a button, its label arrives back through the normal inbound channel exactly
as if typed, with `meta.button_data` set to that button's `data` string, and the message is edited
in place so the same tap cannot fire twice.

Peti asked for it on 2026-08-16, and the root `CLAUDE.md` **requires** it: the unknown-sender
pairing escalation (DEFAULT-DENY branch) says to ask with buttons and to read `button_data` rather
than guess from free text.

It was written straight into the plugin's `server.ts`. That file lives in a git checkout tracking
upstream, and the edit was never committed anywhere. **An upstream pull on 2026-09-01 21:15
discarded it silently.** The marketplace source and the `0.0.7` cache are now byte-identical pure
upstream, with no `buttons` in either.

It kept working only because the project-scope install stayed pinned to the `0.0.6` cache
directory, which happened to survive. That is luck, not a mechanism — and it is precisely the case
the root `CLAUDE.md` update-safety rule forbids: a local edit to a tracked file that an incoming
update would collide with must never sit uncommitted.

## When to run it

**After anything that replaces the plugin's `server.ts`** — a plugin update, a cache repopulation,
a fresh install, or the project-scope pin moving to a newer version.

You do not have to remember. `src/__tests__/telegram-reply-chatid-contract.test.ts` resolves the
copy the fleet actually loads (out of `installed_plugins.json`, project scope) and **fails** if the
fork feature is missing from it. That test is the detector; this directory is the remedy.

```bash
python3 store/telegram-buttons-patch/apply.py --check   # is it in? (0 = yes, 1 = no)
python3 store/telegram-buttons-patch/apply.py           # put it back (idempotent)
python3 store/telegram-buttons-patch/selftest.py        # 17 cases, incl. a real bun parse
```

## Why a patch and not a vendored copy of the file

Four additive hunks on top of whatever version is installed, so upstream keeps flowing. Re-applying
onto `0.0.7` also **gains** two upstream fixes `0.0.6` never had: `CLAUDE_CONFIG_DIR` support in
`STATE_DIR`, and the PID-recycling check that verifies a stale pid really is a `server.ts` before
sending SIGTERM. Freezing a copy of the file would have kept the buttons and thrown those away.

## What it refuses to do

- **A moved anchor is a refusal, not a guess.** Every anchor is verified before anything is
  written; if one is missing or ambiguous, the script names the hunk, writes nothing, and exits 2.
  Re-cut the patch by hand against the new `server.ts`. Do **not** loosen an anchor to make it
  pass: this file carries every Telegram message the fleet sends, and a half-applied `server.ts`
  costs the whole channel — a far bigger outage than the missing button it restores.
- **It starts nothing.** `bun` loads `server.ts` once at startup, so the change takes effect on the
  next `mikrob-channels` restart. That restart is MikroB's call.

## Exit codes (a contract — callers switch on these)

| code | meaning |
|---|---|
| 0 | applied now, or already applied (idempotent); with `--check`: already applied |
| 1 | `--check` only: not applied, and the file is patchable |
| 2 | an anchor is missing or ambiguous — upstream moved, a human must re-cut the patch |
| 3 | the target file could not be resolved or read |

## Files

- `apply.py` — the applier; resolves the live copy from the plugin registry, or `--path` to override.
- `buttons.hunks.json` — the four hunks, each an exact anchor and its replacement.
- `selftest.py` — apply, idempotency, anchor-drift refusal, write-nothing-on-refusal, and a real
  `bun` parse of the patched result. Run on every landing from the vitest file named above.

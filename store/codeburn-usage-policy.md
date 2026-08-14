# CodeBurn -- fleet usage policy and notes (card 56ed32df)

**Status:** adopted with limits. Peti approved ADAPT on 2026-08-12 after the security audit
(card a79308f2: Cybersec deliverable, Cybered independent GO, QA PASS).

## What is installed

| | |
|---|---|
| package | `codeburn` (npm), MIT, `github.com/getagentseal/codeburn` |
| version | **0.9.20 — pinned, and the pin is the point:** this is the exact version the audit read |
| location | `~/.local/lib/node_modules/codeburn`, binary `~/.local/bin/codeburn` |
| scope | **per-user, not system-wide.** `npm config get prefix` is `/usr` on this box, so a plain `-g` install would need root and write `/usr/lib/node_modules`. `--prefix ~/.local` avoids both. |

Installed with `npm install -g --prefix "$HOME/.local" codeburn@0.9.20`. This does **not** touch the
shared `/home/neon/marveen/node_modules` the live dashboard runs on — checked before installing, and
the reason `npm-protect-guard` had to be bypassed deliberately for this one command (see the note at
the end).

**Do not install `codeburn@latest`.** The audit's conclusions are about 0.9.20's source. A later
version is unaudited code with network capability, and upgrading is a decision, not maintenance.

## What it answers, and why it is not a quota-check replacement

They answer different questions and neither can answer the other's:

- `store/quota-check.sh` — *"are we rate-limited right now?"* Liveness: 5-hour window state, stale
  limit-modal detection, restart probe. Operational, drives the fleet's stop/resume.
- **CodeBurn** — *"where did the spend actually go?"* Attribution: by model, project, task type, day.
  Retrospective, drives model-tiering and cost decisions.

Measured on this machine, 2026-08-14 (`codeburn overview`, this month):

```
Cost $16,024.32   Tokens 45,304,144,103   Calls 109,921   Sessions 278   Cache hit 100.0%
Opus 5    $6,842.58   23,876 calls
Sonnet 5  $6,436.69   60,029 calls
Opus 4.8  $1,773.61    7,000 calls
Sonnet 4.6  $960.68   18,352 calls
Haiku 4.5    $10.76      529 calls
```

That per-model split is the concrete thing we did not have: the model-ladder rules were argued
without a measured cost-per-model for the fleet. `codeburn status` gives the one-line version
(`Today $2184.25 / 13701 calls`).

**It is deliberately NOT wired into `quota-check.sh` or any scheduled task** (card 56ed32df point 5).
It is an optional tool someone runs and reads. Automating it would make an unaudited-by-default
upgrade path load-bearing for the fleet's own quota control.

## PROHIBITED on every fleet machine

These are not preferences. Each one is the direct consequence of an audited behaviour:

1. **`codeburn share`** — FORBIDDEN. The share server binds **0.0.0.0**, not loopback (three
   `listen()` call sites in the bundle, confirmed independently by Cybered). The local dashboard is a
   separate server on 127.0.0.1; only the share path exposes the machine.
2. **`codeburn devices --pair` / `devices add`** — FORBIDDEN. Pairing is what turns the exposure into
   a data flow.
3. **The "always share" flag** — FORBIDDEN, and this is the one worth knowing about, because it does
   not look like sharing. Cybered traced it from source: plain `codeburn` (`runWebDashboard()`)
   checks `loadShareAlways()` on startup and, if the flag is set, **restarts the share server by
   itself** — `if (await loadShareAlways()) await share.start(true)`. Set it once and every later
   "just looking at the dashboard" re-exposes the machine, with no `share` command in sight.

   The flag persists here, and it is absent on a clean machine (absent means `always: false`):

   ```bash
   cat ~/.config/codeburn/sharing/web-share.json   # expect: no such file, or {"always":false}
   ```

   Traced to `getSharingDir() -> join(dirname(getConfigFilePath()), "sharing")` with
   `getConfigDir() -> ~/.config/codeburn`. Verify the file, not the intention.

4. Never enable it through the local web UI either. The flag is written by a `POST /api/share/start`
   on the 127.0.0.1 dashboard — a checkbox, not a command line.

### Why the share ban is broader than "prompts might leak"

The original worry was prompt text in `topActivities.name`. **That specific worry is closed**:
Cybered followed it to `CATEGORY_LABELS[cat] ?? cat` over `classifyTurn()`, which can only return one
of 13 fixed category strings, and the dictionary covers all 13 — the fallback can never fire with raw
text. No prompt content reaches that field.

The ban stands on a different finding. `sanitizeForSharing()` is a **denylist**: it empties
`topProjects`, `topSessions` and the session series, and everything else passes through the spread
unchanged. Two fields survive that a paired device would see:

- `current.byBranch[].branch` — real git branch names, e.g. `fix/photoapproval-router-wiring-2268f00d`,
  which leaks both the card id and the feature area;
- `current.pullRequests` — PR URLs.

A denylist that has to be right about every future field is the wrong shape for a trust boundary, and
that is the argument, independent of how benign today's field list looks.

## Safe to run

`npm install` runs no scripts from this package — no `preinstall`/`install`/`postinstall` in its
`package.json` (audited, and re-confirmed independently). The read-only commands used here (`status`,
`overview`, `models`, `sessions`) read local session files and open no socket. Verified after running
them: no wildcard-bound listener exists on this box (`ss -ltn` shows only 127.0.0.1:3420,
127.0.0.1:11434 and DNS).

Prefer those over bare `codeburn` / `codeburn web`: the bare command is the one that consults the
always-share flag on startup.

## One deliberate guard bypass, recorded

`npm-protect-guard` blocks `npm install` in `/home/neon/marveen` because it protects the shared
`node_modules` the live dashboard runs from. It matches the command text and does not distinguish
`-g`, so it also blocks global installs that cannot touch that directory. This one command was run
with `MARVEEN_ALLOW_NPM_WRITE=1` after checking `npm root -g` and choosing `--prefix ~/.local`, so
nothing under `/home/neon/marveen` was written. **Worth fixing in the guard** rather than repeatedly
bypassing: a `-g`/`--prefix` outside the checkout is not the risk the guard exists for, and a control
that has to be switched off for legitimate work gets switched off habitually.

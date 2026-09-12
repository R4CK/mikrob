# Git force-push guard

Marveen agents run autonomously, often with shell access and the ability to push
to git, so a prompt-injected or simply mistaken agent can rewrite shared history.
This guard reduces that blast radius without changing how the fleet works.

## What it does

`scripts/install-git-guard-hook.sh` installs a `pre-push` hook that **refuses a
non-fast-forward (force / rebase / amend) push to `main` or `master`**. Normal
fast-forwards and merge commits pass untouched, and every other ref (`develop`,
feature branches, fork branches, including `--force-with-lease` to those) is
unaffected: only history rewrites of a protected branch are blocked.

It is named `install-*-hook.sh`, so `scripts/sync-hooks.sh` (and the dashboard
update flow) run it automatically. It composes with an existing `pre-push` hook
(e.g. a secret scanner) by moving it under `.git/hooks/pre-push.d/` and adding a
small dispatcher that feeds the ref list to every sub-hook.

```bash
scripts/install-git-guard-hook.sh   # runs automatically on update; manual run also works
```

Override an intentional rewrite of a protected branch:

```bash
ALLOW_FORCE_PUSH=1 git push ...
```

# Bash egress deny rules

`scripts/hooks/egress-gate.mjs` compares a URL against the allowlist, but it is
wired as a `PreToolUse` hook with matcher `WebFetch` **only**. Bash was never
ungated (`outgoing-copy-gate.py` and `email-approval-gate.py` on the main agent,
`email-send-gate.mjs` and `self-pace-gate.mjs` on sub-agents) but none of those
gates looks at the destination host, so a shell `curl` never met the allowlist.
The realistic threat is not a malicious agent: it is a fetched page telling an
agent to run a `curl`, which is why the quarantine-reader exists in the first
place.

## STATUS: the wget/nc/ncat/telnet half ships; the curl half does NOT (cards f6db6978, 854182c7)

What this fork actually enforces is NARROWER than the upstream design described below, and the
narrowing is measured rather than cautious. `BASH_EGRESS_DENY` here is:

    Bash(wget *)   Bash(*/wget *)   Bash(nc *)   Bash(*/nc *)
    Bash(ncat *)   Bash(*/ncat *)   Bash(telnet *)   Bash(*/telnet *)

**A shell `curl` is NOT gated.** Do not read the section below as saying otherwise.

WHY THE curl RULE IS ABSENT. Measured on the real engine (Claude Code 2.1.263, these rules, under
`--dangerously-skip-permissions` -- so the bypass is not what saves anything). A probe either
reported `DENIED` or its command's actual exit code, because a model saying "done" does not prove
the command ran:

| rule set | command | result |
| --- | --- | --- |
| upstream's | `echo ...` | RAN exit=0 |
| upstream's | `curl -s ... https://127.0.0.1:1/` | DENIED |
| upstream's | `curl ... http://127.0.0.1:9 -d "{...https://...}"` | DENIED |
| upstream's | `curl ... http://127.0.0.1:9 -d '{...https://...}'` | DENIED |
| upstream's | `curl ... http://127.0.0.1:9 -d '{...no https...}'` | RAN exit=7 |
| upstream's | `wget -q -O /dev/null http://127.0.0.1:9/` | DENIED |
| anchored `Bash(curl https://*)` | `curl -s ... https://127.0.0.1:1/` | RAN exit=7 |
| anchored `Bash(curl https://*)` | `curl https://127.0.0.1:1/` (no flags) | DENIED |
| anchored `Bash(curl https://*)` | the fleet's own localhost write | RAN exit=7 |

The rule matches the COMMAND STRING, not the destination. With a leading `*` it refuses this
fleet's own writes -- every internal path is a `curl` to `http://localhost:<port>/api/...` whose
payload routinely carries a link (memories, kanban comments, inter-agent messages, the daily log)
-- and quoting does not help, which contradicts the note upstream's own test carries. Anchored
instead, a single flag walks past it, and real commands always have one. There is no third form:
the language has no negation and `*` compiles to an anchored full match, so the target URL cannot
be told apart from payload text.

The curl case therefore needs a PreToolUse hook that parses the command and looks at the
destination -- the shape this fork already uses for its other gates. That is card 854182c7.

WHAT THE SHIPPED HALF IS WORTH, stated honestly: `wget`, `nc`, `ncat` and `telnet` have no internal
use in this install at all, so denying them whole is protection with no false positive -- the wget
denial is measured above. It does not close the shell-fetch hole, because `curl` is the tool an
agent actually reaches for; it removes the other verbs from the menu while the real fix is built.

## What the upstream design does


`BASH_EGRESS_DENY` in `src/web/agent-scaffold.ts` is the single source of truth
for a small `permissions.deny` list that lands in **every** agent's
`settings.json`:

- on spawn, via `writeAgentSettingsFromProfile()`,
- on server startup, via `ensureBashEgressDeny()` (existing fleet, and the main
  agent -- see the scope note below),
- on scaffold, via `templates/settings.json.template` (so the next agent created
  starts gated -- a parity test keeps the template and the constant in step).

Denied: `curl` to an `https://` URL, and `wget` / `nc` / `ncat` / `telnet`
outright. A `deny` rule is checked **before** the
`--dangerously-skip-permissions` bypass, so it binds on permissive profiles too.
Sanctioned tooling that speaks HTTPS on its own account (`git`, `gh`, `npm`) is
deliberately untouched: denying it would break the release path without closing
anything an agent could not do through it anyway.

The sanctioned route for external content is unchanged: the quarantine-reader
sub-agent, through `WebFetch`, where the domain check already runs. A host being
on the egress allowlist does not open it to the shell.

## Where the main agent's copy goes

The main agent's nominal settings path is the shared user root
(`~/.claude/settings.json`) -- and that same file is the operator's own
interactive Claude Code sessions. The owner's decision (2026-09-07) was that
their own shell stays unrestricted while the fleet stays gated, which makes the
shared file unusable in both directions: writing there restricts the operator,
removing it from there un-gates the main agent, which is the one agent that
reads untrusted web content on the owner's behalf.

Measured way out: when the install gives the main agent a config dir of its own
(`MAIN_AGENT_CONFIG_DIR`, or the provisioned isolated dir behind
`MAIN_AGENT_ISOLATED_CONFIG`), that dir's `settings.json` is the agent's user
scope and the operator's shell does not read it. `bashEgressDenyTargetPath()`
sends the rules there. The separation survives restarts: the provisioner
rebuilds that file from the shared one on every start but keeps keys the shared
file never mentions, and `permissions` is such a key.

When the main agent runs on the shared root there is no scope that covers it
without covering the operator, so **nothing is written** and the startup log
says so. Giving the main agent its own config dir is the fix; picking a side
quietly is not this code's call.

## The trap for whoever measures this next

The two scopes do not behave the same way, and the difference is invisible until
it misleads you (both measured 2026-09-07):

- The **project scope** (`<cwd>/.claude/settings.json` and `settings.local.json`)
  is re-read while a session runs. A rule written there fires immediately, which
  makes it a fine live test bench: drop a narrow, unique rule in, probe it, then
  delete the file.
- The **user scope** (the `settings.json` in the session's `CLAUDE_CONFIG_DIR`)
  is read when the session STARTS and is not re-read afterwards. A rule written
  there while the session runs does nothing at all.

So a probe that works perfectly on the project scope reports a confident
"allowed" on the user scope, and the honest-looking conclusion -- "the rule does
not work" -- is wrong. What it means is "this session has not read it yet".
Measure a user-scope rule from a session that started AFTER the write, or after
the next restart.

The same asymmetry is why a newly written rule binds the main agent from its
next restart rather than immediately.

## Limits, stated out loud

This is a deny list, not a sandbox.

- **The localhost exception is why only `https://` is denied for `curl`.** The
  rule language has no negation and `deny` always beats `allow`, so "any
  `http://` host except localhost" cannot be expressed. A `*http://*` rule would
  also match `http://localhost:3420/...` and mute the whole fleet (memory,
  kanban, message queue, approvals all ride that URL).
- Still open, by construction: plain-http external fetches, an interpreter
  one-liner (`python3 -c`, `node -e`), and a URL hidden in a shell variable.
  Closing those needs a Bash `PreToolUse` hook that parses the command.
- Known collateral: an internal POST whose **double-quoted** payload quotes an
  `https://` URL matches the `curl` rule. Single-quoted payloads do not (the
  permission engine excludes single-quoted content). Use single quotes or
  `-d @file` for such a call.

# Weekly Claude limit % — auto-read feasibility (card c9ce4254)

**Ask (Peti 2026-07-25):** the dashboard "Heti Claude limit" widget is manual %-entry;
automate it from the `/status` weekly value.

**Finding (feasibility-first, re-verified FRESH 2026-07-25 — not from memory):**
there is **no reliable programmatic source** an agent/script can use today. The existing
manual snapshot (`src/costops/weekly-limit.ts` + `store/weekly-limit-snapshot.json`,
card 8388642a) remains authoritative. Both candidate sources were checked live:

## (b) OAuth usage endpoint — BLOCKED on token scope
The fleet token in `marveen/.env` is `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat0…` (a
coding/inference OAuth token). Live probe (`store/weekly-usage-probe.sh`, re-runnable):

| endpoint | result |
|---|---|
| `GET https://api.anthropic.com/api/oauth/profile` | **HTTP 403** `permission_error` — `OAuth token does not meet scope requirement any_of(user:profile, user:office)` (request_ids `req_011CdNBKErN4LuisGPQpX2uQ`, `req_011CdNBKFeEmYzMVLzfNp5yY`) |
| `GET .../api/oauth/usage` | **HTTP 429** `rate_limit_error` under repeated probing (shares the account-scope family; needs an account scope the coding token does not carry) |

The design-scoped token in `~/.claude/.credentials.json` (`user:design:read/write`, the
Stitch token) is a different client entirely → **HTTP 401** on both endpoints. So no
token on the box carries an account scope.

## (a) `/status` parse from a spare panel — BLOCKED for agents + wrong panel
- The CLAUDE.md `/status` procedure is a **MikroB-only** action: a role sub-agent is
  **governance-blocked** from `tmux send-keys` (hard-gate: "Self-pace TILTOTT … se tmux
  send-keys"). So an agent/script cannot drive `/status` at all.
- Per MikroB's earlier verified fact, the spare panels (`mikrob-worker`,
  `mikrob-worker-fast`) run activity-only auth → their `/status` Usage shows the
  activity heatmap/tokens, **not** the weekly "All models" subscription bar. The
  subscription bar only renders in the shared-auth working fleet panels, into which
  firing `/status` is forbidden (disrupts work).

## Two unlocks — both OUTSIDE an agent's authority (escalated to MikroB)
1. **Peti re-issues the OAuth token WITH an account scope** (`user:profile`/`user:office`)
   — if Anthropic grants that to a setup-token at all. Then `store/weekly-usage-probe.sh`
   starts returning real data and can be cron'd (writes the snapshot with `source=oauth`).
2. **A MikroB-run `/status` parse** from a genuinely subscription-authed spare panel
   (only MikroB can `send-keys`; and it must be a panel that actually shows the weekly bar).

## What this card delivered (concrete, no external dep)
- `store/weekly-usage-probe.sh` — re-runnable OAuth probe + **forward-compatible**
  auto-reader. Fail-safe: on any scope/auth/ratelimit/parse failure it prints the exact
  reason + request_id and exits non-zero **without** touching the snapshot (a cron never
  overwrites the operator's manual value with a fake/stale one). On a real 200 with a
  parseable weekly %, it atomically writes `store/weekly-limit-snapshot.json`
  (`source=oauth`). The token is read from `.env` at call time and never printed/logged.
- `src/costops/weekly-limit.ts` — widened the snapshot `source` union to
  `'manual' | 'oauth'` and made the reader pass the stored source through (an auto-read is
  never mislabelled manual; unknown falls back to `manual`). Header re-dated with the
  fresh evidence. Behaviour for the existing manual path is unchanged.

**Net:** the "automatic" part is Peti/MikroB-gated (unlock #1 or #2); the manual entry
stays authoritative and correct meanwhile, and the auto-read harness is in place to
activate with zero further code once a properly-scoped token exists.

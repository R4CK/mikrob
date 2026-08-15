# Firecrawl -- adoption decision and the one thing that blocks it (card 91c4a369)

**Capability gap being closed:** `WebFetch`/`WebSearch` cannot do JS-heavy structured scraping.

**Status: BLOCKED on an API key.** Everything that does not depend on the key is decided and written
down below; the key itself is Peti's to obtain (external account, and the paid tiers make it a
`payment`-class action, which is autonomy level 1 = locked).

## Decision: the official MCP server against the HOSTED API. No custom client, no embedded code.

| | |
|---|---|
| adopt | `firecrawl-mcp` (npm), **MIT**, `github.com/firecrawl/firecrawl-mcp-server`, 3.24.0 |
| via | `@mendable/firecrawl-js` (its dependency), **MIT**, official SDK for the hosted API |
| do NOT adopt | the `firecrawl/firecrawl` server itself -- **AGPL-3.0**, and its network clause is exactly why the card says hosted-only |

**The licence question the card raised is answered by measurement, not by assumption.** The AGPL
applies to the self-hostable server. The client packages we would actually run are MIT:

```
npm view firecrawl-mcp license          -> MIT   (3.24.0, published 2026-08-12)
npm view @mendable/firecrawl-js license -> MIT   (4.32.1)
```

So calling the hosted API through the official MIT client embeds no AGPL code and triggers no network
clause. Writing our own HTTP client would be worse on every axis (rule 10: do not rebuild what an
official, maintained, correctly-licensed client already does) and would not change the licence story.

## Key handling: the key never touches disk-resident config

The fleet already has the mechanism, so this needs no invention:

- `scripts/vault-env-wrapper.sh` resolves `vault:` references in env vars and then execs the real
  command -- the MCP server launches with the secret in its environment, and `.mcp.json` holds only
  the vault id.
- Claude Code additionally expands `${VAR}` inside an MCP server's `env`/`args`/`headers` in every
  config scope, so `"FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"` works with a launch-time export.
  **This is the road NOT taken** -- it is written down because it exists, not because we use it. The
  deployed entry is the `vault:` one below; an export-based variant would put the key in the
  launching process's environment, which is what the vault wrapper exists to avoid.

The entry, as it is LIVE today in this agent's `.mcp.json` (see "DECIDED AND ACTIVATED" below). This
block is byte-for-byte what is deployed, not a sketch -- it is the one people copy, so it must not
drift from the real config:

```jsonc
"firecrawl": {
  "type": "stdio",
  "command": "/home/neon/marveen/scripts/vault-env-wrapper.sh",
  "args": ["npx", "-y", "firecrawl-mcp@3.24.0"],
  "env": { "FIRECRAWL_API_KEY": "vault:Firecrawl" }
}
```

Pin the version deliberately (`@3.24.0`), for the same reason CodeBurn is pinned: an auto-upgraded
package with network capability is unaudited code on the fleet's machine.

## Verifying it, when the key exists -- and the trap in that verification

**`✔ Connected` in `claude mcp list` is NOT proof the key works.** Measured previously on this fleet
(memory `mcp-header-env-expansion-and-connect-is-not-the-oracle`): with the variable unset, an MCP
server still reports Connected, because the remote authenticates per tool call, not at connect. The
real signal is the diagnostics warning line:

```
[Warning] [firecrawl] mcpServers.firecrawl: Missing environment variables: FIRECRAWL_API_KEY
```

So the acceptance procedure is:

1. Store the key in the vault under the label `Firecrawl` (never in `.mcp.json`, never in a shell
   history, never in a log line). The label is the literal string after `vault:` in the entry above;
   they have to match exactly or `vault-env-wrapper.sh` resolves nothing.
2. Add the entry above, restart the session.
3. A/B it: run once with the vault entry present and once with it removed. Both will say Connected;
   only the second prints the warning. **Read the warning line, not the status.**
4. Make one real scrape call against a JS-heavy page and confirm structured output -- that, not the
   handshake, is the proof the capability gap is closed.
5. Grep the resulting transcript/log for the key's literal value: it must appear nowhere.

## Why it is not activated now

Adding an MCP server whose credential is absent would put a permanently-warning, tool-call-failing
server into every agent's startup. A control that is present but broken is worse than one that is
openly missing: the next reader sees `firecrawl` in the config and believes the capability exists.
The config lands in the same change as the key, not before it.

## What Peti needs to decide

1. **Create the Firecrawl account and issue an API key** (free tier exists; the useful volume is
   paid -- a spend decision, hence level 1 / locked for the fleet).
2. Whether the key goes in the shared vault (all agents can scrape) or is scoped to one agent.

## BLOCKING PREREQUISITE: scraped content must not arrive unwrapped (Cybersec, HIGH)

**Read this before the four lines of `.mcp.json` look like the whole job.** They are not.

An MCP tool result lands **directly in the calling model's context**. Every other external fetch in
this fleet goes through the `quarantine-reader` sub-agent and then `wrapUntrustedFetch()`
(`~/.claude/agents/quarantine-reader.md`, `src/prompt-safety.ts:136`,
`src/__tests__/prompt-injection-defense.test.ts`). Wiring firecrawl naively would therefore create the
fleet's **first unwrapped external-content channel** — and scraped pages are the highest-yield
prompt-injection surface there is, which is the entire point of the capability we are adding.

One of three outcomes must be chosen and written down on activation day. "It's an MCP tool" is not a
reason — that is the mechanism of the bypass, not a justification for it.

**Recommended: (a), routing the call through `quarantine-reader`.** It reuses the boundary that
already exists and is already tested, instead of adding a second, discipline-based one. Mechanics,
checked against the current definitions:

- `quarantine-reader` declares `tools: WebFetch`. It needs the firecrawl MCP tool added to that list
  — that is the whole change; its protocol already returns `{ url, nonce, status, content }`.
- The caller then wraps with `wrapUntrustedFetch(url, content, nonce)` exactly as today. Keeping the
  **nonce** matters beyond tidiness: it is embedded in the tag, so if scraped content later triggers
  an exfiltration tool call, the tool input carries the nonce and names the exact fetch that
  delivered the payload.
- Honest limit: even here the raw content reaches the SUB-AGENT unwrapped. The protection is that the
  sub-agent has no other tools and cannot act on injected instructions, and its output is data the
  caller wraps. That is the same trade the existing WebFetch path already makes — consistent, not a
  new exposure.

(b) wrapping at each call site works, but depends on every future caller remembering; (c) an explicit,
argued exception is allowed but must state what makes this channel different from every other fetch.

Three smaller items for the same day (not blocking, but record the decision):

1. **Vault scope — shared key vs one agent.** A blast-radius decision, not a convenience one: with a
   shared key, any agent's compromise takes the key with it. Peti should decide this knowingly.
2. **The acceptance grep for the key's literal value must include the `agents/**` tree**, not just the
   session transcript.
3. **Size/time limit on returned content.** There is none today; the quarantine protocol already
   truncates at 50 000 chars, which is the natural precedent.

Licence checked one level deeper by Cybersec and still clean: the client's transitive dependency
`firecrawl` 4.30.1 — the place an AGPL payload could hide behind an MIT wrapper, because it shares the
project's name — is MIT too, with no unusual dependencies.

## DECIDED AND ACTIVATED (2026-08-14)

The key arrived. Peti scoped it to **this agent's config only**, not shared fleet-wide use, and the
vault label is **`Firecrawl`** -- an earlier draft of this document guessed `firecrawl.apiKey` and
was wrong. That guess is corrected at every occurrence now, not just noted here (QA finding on card
91c4a369): a note further down does not undo a wrong value further up, because the wrong value is
the copy-pasteable one and the note is not.

**Quarantine outcome chosen: (a) -- the call goes through `quarantine-reader`.** In order of weight:

1. It reuses the boundary that already exists and is already tested, instead of adding a second one
   that depends on every future caller remembering.
2. It answers the size-limit item for free: the quarantine protocol already truncates content at
   50 000 characters, so the "no limit on returned content" gap closes with the same decision instead
   of needing its own mechanism.
3. It keeps the **nonce**, which is what makes an incident investigable: the nonce is embedded in the
   `<untrusted>` tag, so if scraped content later causes an exfiltration tool call, the tool input
   carries the nonce and names the exact fetch that delivered the payload.

**The honest limit of that choice, stated rather than papered over.** A sub-agent's `tools:` list is
an ALLOWLIST for that sub-agent; it does not remove the MCP tool from the agent that owns the server.
So the sanctioned path exists and is the rule -- but the owning agent can still call the tool
directly, and nothing mechanically prevents that today. That is discipline, not enforcement, and
calling it enforcement would be exactly the "control we wrongly believe is closed" this fleet keeps
finding. A `PreToolUse` hook denying `mcp__firecrawl__*` outside the sub-agent is how to make it real,
in the same shape as `git-protect-guard` / `npm-protect-guard`; it is recorded as the follow-up rather
than claimed here, because I have not verified that such a hook can tell the sub-agent caller apart.

**Blast radius (item 1) is answered by the scope Peti chose:** one agent's config holds the key, so a
compromise of any other agent does not carry it. That is the smaller radius of the two options, and it
was decided knowingly rather than by default.

**Item 2 stands for the acceptance run:** the grep for the key's literal value covers `agents/**`, not
only the session transcript.

## What is left once the key exists

The `.mcp.json` entry above, the quarantine decision from the previous section, and the acceptance
run — in that order. The middle one is the part that will feel skippable and is not.
